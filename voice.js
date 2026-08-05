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

  _listening: false,
  _speaking: false,
  _shouldListen: false,   // 标记是否应该在说话结束后恢复监听
  _restartTimer: null,
  _healthCheckTimer: null, // 定期健康检查定时器
  _recognitionRunning: false, // 识别引擎是否正在运行

  // ---- 回调 ----
  onRecognize: null,
  onInterim: null,
  onSubtitle: null,
  onSpeakStart: null,
  onSpeakEnd: null,
  onUtteranceStart: null, // 单句语音实际开始播放时触发（用于嘴部动画同步）
  onListenStart: null,
  onListenEnd: null,

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

    const loadVoices = () => {
      this.voices = this.synthesis.getVoices();

      // 打印所有可用语音，方便调试
      const zhVoices = this.voices.filter(v => v.lang.startsWith('zh'));
      console.log('[Voice] 可用中文语音:', zhVoices.map(v => `${v.name} (${v.lang})`).join(', '));

      // 智能选择最佳中文语音
      // 优先级：Google语音 > 微软自然语音 > 微软女声 > 任意中文
      this.chineseVoice =
        // 1. Google 中文语音（Chrome内置，音质最好）
        this.voices.find(v => v.lang === 'zh-CN' && /google/i.test(v.name)) ||
        this.voices.find(v => v.lang.startsWith('zh') && /google/i.test(v.name)) ||
        // 2. 微软晓晓（自然语音，音质好）
        this.voices.find(v => v.lang === 'zh-CN' && /xiaoxiao/i.test(v.name)) ||
        // 3. 微软瑶瑶（声音年轻自然）
        this.voices.find(v => v.lang === 'zh-CN' && /yaoyao/i.test(v.name)) ||
        // 4. 微软慧慧（系统默认女声）
        this.voices.find(v => v.lang === 'zh-CN' && /huihui/i.test(v.name)) ||
        // 5. 任意中文女声
        this.voices.find(v => v.lang === 'zh-CN' && /female|女/i.test(v.name)) ||
        // 6. 任意zh-CN语音
        this.voices.find(v => v.lang === 'zh-CN') ||
        this.voices.find(v => v.lang.startsWith('zh')) ||
        this.voices[0] ||
        null;

      if (this.chineseVoice) {
        console.log('[Voice] 已选择 TTS 语音:', this.chineseVoice.name, this.chineseVoice.lang);
      } else {
        console.warn('[Voice] 未找到中文语音，将使用默认语音');
      }
    };

    loadVoices();
    // Chrome 异步加载语音
    if (this.synthesis.addEventListener) {
      this.synthesis.addEventListener('voiceschanged', loadVoices);
    }
    // 兜底：延迟再加载一次
    setTimeout(loadVoices, 500);
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

      // 自动重启：如果应该监听，延迟后重启（说话时也保持监听，用于唤醒词检测）
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
    // 说话时也保持监听，用于唤醒词检测
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
   */
  speak(sentences, voiceConfig = {}) {
    if (!this.synthesis) {
      console.warn('[Voice] TTS 不可用，跳过朗读');
      if (this.onSpeakEnd) this.onSpeakEnd();
      return;
    }

    // 停止当前朗读（但保持监听，用于唤醒词检测）
    this.synthesis.cancel();

    this._speaking = true;
    if (this.onSpeakStart) this.onSpeakStart();

    // 确保是数组
    const lines = Array.isArray(sentences) ? sentences : [sentences];
    const pitch = voiceConfig.pitch ?? 1.15;
    const rate = voiceConfig.rate ?? 1.05;

    let index = 0;

    const speakNext = () => {
      // 如果已被 stopSpeaking 中止，不再继续
      if (!this._speaking) return;

      if (index >= lines.length) {
        this._speaking = false;
        if (this.onSpeakEnd) this.onSpeakEnd();
        return;
      }

      const text = lines[index].trim();
      if (!text) {
        index++;
        speakNext();
        return;
      }

      // 更新字幕
      if (this.onSubtitle) this.onSubtitle(text);

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN';
      utterance.pitch = pitch;
      utterance.rate = rate;
      utterance.volume = 1;
      if (this.chineseVoice) utterance.voice = this.chineseVoice;

      // 声音实际开始播放时才触发嘴部动画
      utterance.onstart = () => {
        if (this.onUtteranceStart) this.onUtteranceStart();
      };

      utterance.onend = () => {
        index++;
        // 短暂停顿后继续下一句，让字幕有展示时间
        setTimeout(speakNext, 400);
      };

      utterance.onerror = (e) => {
        console.warn('[Voice] TTS 错误:', e.error);
        index++;
        setTimeout(speakNext, 200);
      };

      this.synthesis.speak(utterance);
    };

    // 小延迟确保 cancel 完成
    setTimeout(speakNext, 100);
  },

  stopSpeaking() {
    if (this.synthesis) {
      this.synthesis.cancel();
    }
    this._speaking = false;
  }
};
