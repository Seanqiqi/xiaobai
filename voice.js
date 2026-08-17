/**
 * voice.js — 语音识别 (STT) + 语音合成 (TTS) 模块
 * ====================================================
 * 基于 Web Speech API，无需后端服务器。
 * 推荐使用 Chrome 或 Edge 浏览器以获得最佳兼容性。
 *
 * 公开接口：
 *   VoiceManager.init()                      初始化
 *   VoiceManager.startListening()            开始监听麦克风
 *   VoiceManager.stopListening()             停止监听
 *   VoiceManager.speak(sentences, config)    逐句朗读（同步字幕）
 *   VoiceManager.stopSpeaking()              停止朗读
 *   VoiceManager.isSupported                  是否支持语音识别
 *
 * 回调（由 app.js 设置）：
 *   onRecognize(text)       识别到最终文本时触发
 *   onInterim(text)         识别到临时文本时触发
 *   onSubtitle(text)        每句开始朗读时触发（用于字幕同步）
 *   onSpeakStart()          朗读开始
 *   onSpeakEnd()            全部朗读结束
 *   onListenStart()         麦克风开始监听
 *   onListenEnd()           麦克风停止监听
 */

const VoiceManager = {
  // ---- 内部状态 ----
  synthesis: null,
  recognition: null,
  voices: [],
  chineseVoice: null,
  _isChildVoice: false,   // 当前选中的是否为童声语音（用于音调自适应）

  _listening: false,
  _speaking: false,
  _shouldListen: false,   // 标记是否应该在说话结束后恢复监听
  _restartTimer: null,
  _healthCheckTimer: null, // 定期健康检查定时器
  _recognitionRunning: false, // 识别引擎是否正在运行
  _lastSpokenText: '',    // 最近播放的TTS文本（用于回声过滤）
  _lastSpokenTime: 0,     // 最近播放时间戳
  _voicePollTimer: null,  // 语音轮询定时器（等待Edge在线Neural语音加载）
  _voiceLoadCount: 0,     // 语音加载次数计数
  _keepAliveTimer: null,  // TTS 队列保活定时器（防止 Chrome 15 秒自动暂停 bug）
  _boundaryTimer: null,   // 字幕边界回退定时器（onboundary 不生效时兜底）

  // ---- 回调 ----
  onRecognize: null,
  onInterim: null,
  onSubtitle: null,
  onSpeakStart: null,
  onSpeakEnd: null,
  onUtteranceStart: null, // 单句语音实际开始播放时触发（用于启动嘴部动画）
  onUtteranceEnd: null,   // 单句语音结束时触发（用于停止嘴部动画，闭嘴等待下一句）
  onListenStart: null,
  onListenEnd: null,
  onVoiceReady: null,     // 语音加载完成时触发（voice, isChild, isOnline）
  onVoiceWarning: null,   // 未找到在线Neural语音时触发（voice）

  // ---- 兼容性检测 ----
  isSupported: false,

  // ==================== 初始化 ====================

  init() {
    this.synthesis = window.speechSynthesis;
    this._initTTS();
    this._initSTT();
  },

  // ---- TTS 初始化 ----
  _initTTS() {
    if (!this.synthesis) {
      console.warn('[Voice] 浏览器不支持语音合成 (TTS)');
      return;
    }

    this._voiceLoadCount = 0;
    this._voicePollTimer = null;

    const loadVoices = () => {
      this._voiceLoadCount++;
      this.voices = this.synthesis.getVoices();

      // 打印所有可用语音，方便调试
      const zhVoices = this.voices.filter(v => v.lang && v.lang.startsWith('zh'));
      console.log(`[Voice] 第${this._voiceLoadCount}次加载，中文语音(${zhVoices.length}个):`,
        zhVoices.map(v => `${v.name} (${v.lang})`).join(' | '));

      // 选择最佳语音
      const prevVoice = this.chineseVoice;
      const prevIsOnline = prevVoice && /online|natural/i.test(prevVoice.name);
      const newVoice = this._selectBestVoice();
      const newIsOnline = newVoice && /online|natural/i.test(newVoice.name);

      // 不降级保护：已有在线Neural语音时，不切换到本地语音
      if (prevIsOnline && newVoice && !newIsOnline) {
        console.log('[Voice] 已有在线Neural语音，跳过本地语音:', newVoice.name);
      } else {
        this.chineseVoice = newVoice;
      }

      // 判断是否为童声语音（匹配中英文名）
      this._isChildVoice = !!(this.chineseVoice && /xiaoshuang|晓双/i.test(this.chineseVoice.name));

      // 语音发生变化时打印日志
      if (this.chineseVoice && this.chineseVoice !== prevVoice) {
        const voiceType = this._isChildVoice ? '童声' : (newIsOnline ? '在线Neural' : '本地');
        console.log(`[Voice] ✓ 已切换 TTS 语音: ${this.chineseVoice.name} [${voiceType}]`);
        // 通过回调通知 UI
        if (this.onVoiceReady) this.onVoiceReady(this.chineseVoice, this._isChildVoice, newIsOnline);
      }

      // 如果已找到在线Neural语音，停止轮询
      if (this.chineseVoice && /online|natural/i.test(this.chineseVoice.name)) {
        if (this._voicePollTimer) {
          clearInterval(this._voicePollTimer);
          this._voicePollTimer = null;
          console.log('[Voice] 已找到在线Neural语音，停止轮询');
        }
      }
    };

    // 初始加载
    loadVoices();

    // 监听 voiceschanged 事件（Chrome/Edge 异步加载语音时触发）
    if (this.synthesis.addEventListener) {
      this.synthesis.addEventListener('voiceschanged', loadVoices);
    }

    // 轮询兜底：Edge在线Neural语音可能延迟数秒才加载，每500ms检测一次，持续10秒
    this._voicePollTimer = setInterval(() => {
      if (this._voiceLoadCount >= 20) {
        clearInterval(this._voicePollTimer);
        this._voicePollTimer = null;
        // 10秒后仍未找到在线Neural语音，给出提示
        if (this.chineseVoice && !/online|natural/i.test(this.chineseVoice.name)) {
          console.warn('[Voice] ⚠ 10秒内未加载到在线Neural语音，当前使用本地语音:', this.chineseVoice.name);
          console.warn('[Voice] 提示：请在Edge设置 → 语言和内容 → 确保已启用"在线语音"功能，且浏览器联网');
          if (this.onVoiceWarning) this.onVoiceWarning(this.chineseVoice);
        }
        return;
      }
      loadVoices();
    }, 500);
  },

  /**
   * 选择最佳中文语音（童趣优先，在线Neural优先）
   * 同时匹配英文名(Xiaoyi)和中文名(晓伊)，因为Edge在线语音用中文名，本地SAPI用英文名
   */
  _selectBestVoice() {
    const isZh = v => v.lang && (v.lang === 'zh-CN' || v.lang === 'zh-Hans' || v.lang.startsWith('zh'));
    const match = (re) => this.voices.find(v => isZh(v) && re.test(v.name));

    return (
      // 1. 童声晓双（zh-CN-XiaoshuangNeural，真正的童声）
      match(/xiaoshuang|晓双/i) ||
      // 2. 晓伊（年轻活泼女声，最接近童趣效果）
      match(/xiaoyi|晓伊/i) ||
      // 3. 晓梦（甜美可爱女声）
      match(/xiaomeng|晓梦/i) ||
      // 4. 晓萱（活力女声）
      match(/xiaoxuan|晓萱/i) ||
      // 5. 晓悠（悠扬女声，支持cheerful/cute风格）
      match(/xiaoyou|晓悠/i) ||
      // 6. Google 中文语音（Chrome内置，音质好）
      match(/google/i) ||
      // 7. 晓晓（自然语音，音质好）
      match(/xiaoxiao|晓晓/i) ||
      // 8. 瑶瑶（本地年轻女声）
      match(/yaoyao/i) ||
      // 9. 任意在线Neural中文女声（名字含Online/Natural且含"晓"字）
      this.voices.find(v => isZh(v) && /online|natural/i.test(v.name) && /晓/i.test(v.name)) ||
      // 10. 任意在线Neural中文语音
      this.voices.find(v => isZh(v) && /online|natural/i.test(v.name)) ||
      // 11. 慧慧（本地女声）
      match(/huihui/i) ||
      // 12. 任意中文女声
      this.voices.find(v => v.lang === 'zh-CN' && /female|女/i.test(v.name)) ||
      // 13. 任意zh-CN语音
      this.voices.find(v => v.lang === 'zh-CN') ||
      this.voices.find(v => isZh(v)) ||
      this.voices[0] ||
      null
    );
  },

  // ---- STT 初始化 ----
  _initSTT() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      console.warn('[Voice] 浏览器不支持语音识别 (STT)，请使用 Chrome 或 Edge');
      this.isSupported = false;
      return;
    }

    this.isSupported = true;
    this._SR = SR; // 保存构造函数，用于重建
    this._createRecognition();
  },

  _createRecognition() {
    if (!this._SR) return;
    this.recognition = new this._SR();
    this.recognition.lang = 'zh-CN';
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.maxAlternatives = 5;

    this.recognition.onstart = () => {
      this._recognitionRunning = true;
      console.log('[Voice] STT 已启动，正在监听...');
      if (this.onListenStart) this.onListenStart();
    };

    this.recognition.onresult = (event) => {
      let interimText = '';
      let finalText = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          // 合并所有候选结果，提高同音字、谐音字匹配率
          let combined = result[0].transcript;
          for (let j = 1; j < result.length; j++) {
            combined += ' ' + result[j].transcript;
          }
          finalText += combined;
        } else {
          interimText += result[0].transcript;
        }
      }

      // TTS回声过滤：说话期间，忽略与最近播放文本高度重叠的识别结果
      if (this._speaking && this._lastSpokenText) {
        const echoText = finalText.trim() || interimText.trim();
        if (echoText && this._isTTSEcho(echoText)) {
          console.log('[Voice] STT 回声过滤（与TTS文本重叠）:', echoText);
          return;
        }
      }

      if (interimText && this.onInterim) {
        this.onInterim(interimText);
      }
      if (finalText && finalText.trim() && this.onRecognize) {
        console.log('[Voice] STT 最终识别:', finalText.trim());
        this.onRecognize(finalText.trim());
      }
    };

    this.recognition.onerror = (event) => {
      console.warn('[Voice] STT 错误:', event.error);
      this._recognitionRunning = false;

      if (event.error === 'not-allowed') {
        if (this.onListenEnd) this.onListenEnd();
        this._shouldListen = false;
        console.error('[Voice] 麦克风权限被拒绝，请允许麦克风访问');
        return;
      }

      // network/no-speech/aborted 等错误由 onend 自动处理重启
    };

    this.recognition.onend = () => {
      this._recognitionRunning = false;
      if (this.onListenEnd) this.onListenEnd();

      // 自动重启：仅在 _shouldListen 为 true 时（待机/监听状态）重启
      // 说话期间 _shouldListen 为 false，不会重启，避免拾取TTS回声
      if (this._shouldListen) {
        clearTimeout(this._restartTimer);
        this._restartTimer = setTimeout(() => {
          if (this._shouldListen) {
            this._startRecognition();
          }
        }, 200);
      }
    };
  },

  // ==================== 语音识别 (STT) ====================

  _startRecognition() {
    if (!this.recognition) return;
    if (this._recognitionRunning) return; // 已在运行，不重复启动
    try {
      this.recognition.start();
    } catch (e) {
      console.warn('[Voice] STT 启动失败，尝试重建识别引擎:', e.message);
      // 重建识别引擎
      try { this.recognition.abort(); } catch (e2) {}
      this._createRecognition();
      // 延迟后重试启动
      setTimeout(() => {
        if (this._shouldListen && !this._recognitionRunning) {
          try {
            this.recognition.start();
            console.log('[Voice] STT 重建后启动成功');
          } catch (e3) {
            console.error('[Voice] STT 重建后仍无法启动:', e3.message);
          }
        }
      }, 300);
    }
  },

  startListening() {
    if (!this.isSupported) return;
    this._shouldListen = true;
    this._startRecognition();
    this._startHealthCheck();
  },

  stopListening() {
    this._shouldListen = false;
    clearTimeout(this._restartTimer);
    this._stopHealthCheck();
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch (e) {}
    }
  },

  /**
   * 健康检查：每3秒检查一次，如果应该监听但识别引擎没在运行，自动重启
   */
  _startHealthCheck() {
    this._stopHealthCheck();
    this._healthCheckTimer = setInterval(() => {
      if (this._shouldListen && !this._recognitionRunning) {
        console.log('[Voice] 健康检查：识别引擎未运行，尝试重启...');
        this._startRecognition();
      }
    }, 3000);
  },

  _stopHealthCheck() {
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer);
      this._healthCheckTimer = null;
    }
  },

  get isListening() {
    return this._shouldListen;
  },

  get isSpeaking() {
    return this._speaking;
  },

  // ==================== 语音合成 (TTS) ====================

  /**
   * 逐句朗读文本数组，每句开始时触发 onSubtitle 回调
   * @param {string[]} sentences — 要朗读的文本数组
   * @param {object} voiceConfig — { pitch: 0-2, rate: 0.1-10 }
   *               pitch 默认 1.6（童趣偏高音）；若已选中童声语音则自动封顶 1.3
   *               rate  默认 1.0
   */
  speak(sentences, voiceConfig = {}) {
    if (!this.synthesis) {
      console.warn('[Voice] TTS 不可用，跳过朗读');
      if (this.onSpeakEnd) this.onSpeakEnd();
      return;
    }

    // 清理上一次可能残留的定时器
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
    if (this._boundaryTimer) {
      clearTimeout(this._boundaryTimer);
      this._boundaryTimer = null;
    }

    // 停止当前朗读（但保持监听，用于唤醒词检测）
    this.synthesis.cancel();

    this._speaking = true;
    if (this.onSpeakStart) this.onSpeakStart();

    // 确保是数组，并过滤空串
    const rawLines = (Array.isArray(sentences) ? sentences : [sentences])
      .map(s => (s || '').trim())
      .filter(Boolean);

    if (rawLines.length === 0) {
      this._speaking = false;
      if (this.onSpeakEnd) this.onSpeakEnd();
      return;
    }

    // 童趣音调：默认提高音调模拟童声；若已选中童声语音则适当降低，避免过度尖锐
    let pitch = voiceConfig.pitch ?? 1.6;
    const rate = voiceConfig.rate ?? 1.0;
    if (this._isChildVoice) {
      pitch = Math.min(pitch, 1.3); // 童声语音本身已童趣，音调封顶1.3
    }

    // ===== 核心优化：所有句子合并成一个 utterance，消除句间 TTS 初始化/标点停顿 =====
    // 之前每句独立 utterance 导致 Chrome 在句末句号后会"自然停顿"300~800ms，
    // 合并成一条 utterance 后 TTS 一次性合成，句子之间几乎零延迟衔接。
    // 同时用 onboundary 事件 + 字符位置记录，保证字幕仍然逐句切换。

    // 1. 计算每个子句在合并文本中的起始字符位置（用于字幕切换锚点）
    const lineMarks = [];   // [{ start, end, text, index }]
    let cursor = 0;
    const mergedText = rawLines.map((line, idx) => {
      // 句子之间用中文逗号"，"连接，TTS 只会做一个极短停顿（约 80ms），
      // 而不会像句号那样停 300~800ms，同时保证语义仍然连贯。
      const sep = idx > 0 ? '，' : '';
      const seg = sep + line;
      const segStart = cursor;
      cursor += seg.length;
      lineMarks.push({
        start: segStart,
        end: cursor,
        text: line,
        index: idx,
        shown: false,
      });
      return seg;
    }).join('');

    const utterance = new SpeechSynthesisUtterance(mergedText);
    utterance.lang = 'zh-CN';
    utterance.pitch = pitch;
    utterance.rate = rate;
    utterance.volume = 1;
    if (this.chineseVoice) utterance.voice = this.chineseVoice;

    let currentLineIdx = -1;   // 当前正在显示的字幕句索引
    let utteranceEnded = false;
    let boundaryFired = false; // 是否至少触发过一次 onboundary（用于检测兜底是否需要启动）

    // ===== 字幕切换函数：根据 charIndex 找到所在句子，切换到对应字幕 =====
    const switchSubtitleByIndex = (charIndex) => {
      // 找到第一个 end > charIndex 的句子
      for (let i = 0; i < lineMarks.length; i++) {
        if (charIndex >= lineMarks[i].start && charIndex < lineMarks[i].end) {
          if (i !== currentLineIdx && !lineMarks[i].shown) {
            lineMarks[i].shown = true;
            currentLineIdx = i;
            const sentence = lineMarks[i].text;
            // 切换字幕 + 嘴部动画
            if (this.onSubtitle) this.onSubtitle(sentence);
            this._lastSpokenText = sentence;
            this._lastSpokenTime = Date.now();
            if (this.onUtteranceStart) this.onUtteranceStart();
            // 推进下一句的兜底定时器
            scheduleFallbackTimer();
          }
          return;
        }
      }
      // 最后一句结束后 charIndex 会 = mergedText.length，
      // 此时显示最后一句字幕（防止最后一句因 boundary 没触发而不显示）
      if (charIndex >= mergedText.length && currentLineIdx < lineMarks.length - 1) {
        const last = lineMarks[lineMarks.length - 1];
        if (!last.shown) {
          last.shown = true;
          currentLineIdx = lineMarks.length - 1;
          if (this.onSubtitle) this.onSubtitle(last.text);
          this._lastSpokenText = last.text;
          this._lastSpokenTime = Date.now();
          if (this.onUtteranceStart) this.onUtteranceStart();
        }
      }
    };

    // ===== 兜底推进：onboundary 不支持/不精确时，按字数估算每句时长逐句推进字幕 =====
    // 中文 TTS 语速约 3.5~5 字/秒（rate=1.0 时），这里取 4.2 字/秒，并结合 rate 调整。
    const ESTIMATED_CHARS_PER_SEC = 4.2;
    const estCharPerSec = ESTIMATED_CHARS_PER_SEC * rate;
    // 预计算每句的预计时长（毫秒）
    lineMarks.forEach(m => {
      const charCount = m.text.length;
      // 单句预估时长：(字符数 / 每秒字符数) * 1000ms，再打 9 折让字幕略提前
      m.estimatedMs = Math.max(600, (charCount / estCharPerSec) * 1000 * 0.9);
    });

    const scheduleFallbackTimer = () => {
      // 清理上一个兜底计时
      if (this._boundaryTimer) {
        clearTimeout(this._boundaryTimer);
        this._boundaryTimer = null;
      }
      const nextIdx = currentLineIdx + 1;
      if (nextIdx >= lineMarks.length) return; // 已是最后一句，不再兜底
      const curMark = lineMarks[currentLineIdx >= 0 ? currentLineIdx : 0];
      // 等到当前句预估结束时，检查 boundary 是否推进了下一句；如果没有，强制推进
      this._boundaryTimer = setTimeout(() => {
        if (utteranceEnded || !this._speaking) return;
        if (currentLineIdx < nextIdx && !lineMarks[nextIdx].shown) {
          // boundary 没及时推进，兜底强制切换
          switchSubtitleByIndex(lineMarks[nextIdx].start);
        } else {
          // boundary 已正常推进，继续给下一句挂兜底
          scheduleFallbackTimer();
        }
      }, curMark.estimatedMs);
    };

    // ===== Chrome SpeechSynthesis 保活（合并后仍然需要，因为单句超 15 秒仍可能暂停） =====
    this._keepAliveTimer = setInterval(() => {
      if (this._speaking && this.synthesis.speaking && !utteranceEnded) {
        this.synthesis.resume();
      }
    }, 2500);

    // 第一句：onstart 立即显示（不要等第一个 boundary）
    utterance.onstart = () => {
      if (!this._speaking) return;
      switchSubtitleByIndex(0);
    };

    // ===== onboundary 事件：每次字符边界触发时，根据 charIndex 切换字幕 =====
    utterance.onboundary = (ev) => {
      if (!this._speaking) return;
      boundaryFired = true;
      // ev.charIndex 在中文语音下是字符级（Chrome/Edge 在线 Neural 语音支持最佳）
      switchSubtitleByIndex(ev.charIndex ?? 0);
    };

    utterance.onend = () => {
      utteranceEnded = true;
      // 嘴部动画停止（闭嘴）
      if (this.onUtteranceEnd) this.onUtteranceEnd();
      // 清理保活定时器
      if (this._keepAliveTimer) {
        clearInterval(this._keepAliveTimer);
        this._keepAliveTimer = null;
      }
      if (this._boundaryTimer) {
        clearTimeout(this._boundaryTimer);
        this._boundaryTimer = null;
      }
      if (this._speaking) {
        this._speaking = false;
        if (this.onSpeakEnd) this.onSpeakEnd();
      }
    };

    utterance.onerror = (e) => {
      if (e.error === 'canceled' || e.error === 'interrupted') return;
      console.warn('[Voice] TTS 错误:', e.error);
    };

    this.synthesis.speak(utterance);
  },

  stopSpeaking() {
    if (this.synthesis) {
      this.synthesis.cancel();
    }
    this._speaking = false;
    // 清理所有定时器
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
    if (this._boundaryTimer) {
      clearTimeout(this._boundaryTimer);
      this._boundaryTimer = null;
    }
    // 清除回声过滤文本（保留5秒后清除，由调用方控制）
    this._lastSpokenText = '';
  },

  /**
   * 判断STT识别结果是否为TTS回声
   * 规则：识别文本与最近播放的TTS文本有较多重叠字符时判定为回声
   * @param {string} sttText — STT识别文本
   * @returns {boolean}
   */
  _isTTSEcho(sttText) {
    if (!this._lastSpokenText) return false;
    // 短文本（≤4字）不过滤，可能是用户说的唤醒词
    if (sttText.length <= 4) return false;

    const spoken = this._lastSpokenText.replace(/[\s\p{P}]/gu, '');
    const recognized = sttText.replace(/[\s\p{P}]/gu, '');

    // 如果识别文本是TTS文本的子串，或TTS文本是识别文本的子串，判定为回声
    if (spoken.includes(recognized) || recognized.includes(spoken)) {
      return true;
    }

    // 计算重叠字符比例
    let overlapCount = 0;
    const minLen = Math.min(spoken.length, recognized.length);
    for (let i = 0; i < recognized.length; i++) {
      if (spoken.includes(recognized[i])) overlapCount++;
    }
    const overlapRatio = overlapCount / recognized.length;

    // 重叠率超过60%且文本较长时，判定为回声
    if (overlapRatio > 0.6 && recognized.length > 5) {
      return true;
    }

    return false;
  }
};
