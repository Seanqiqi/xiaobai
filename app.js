/**
 * app.js — 主应用逻辑
 * ====================================================
 * 状态机：  IDLE → SPEAKING → STANDBY → (唤醒词"你好") → LISTENING → (识别到角色) → SPEAKING ...
 *
 * 交互流程：
 *   1. 页面加载 → 显示启动按钮
 *   2. 点击启动 → 初始化语音 → 小白出场欢迎 → 进入待机(STANDBY)
 *   3. 用户说"你好" → 唤醒 → 进入监听(LISTENING)
 *   4. 用户语音输入 → 识别角色名/命令 → 切换角色讲解
 *   5. 讲解结束 → 进入待机(STANDBY) → 等待下次唤醒
 *   6. 循环 3-5
 */

const App = {
  // ---- 状态 ----
  state: 'IDLE',        // IDLE | SPEAKING | LISTENING | TRANSITIONING | STANDBY
  currentChar: null,    // 当前角色对象
  charIndex: 0,         // 当前角色在数组中的索引

  // ---- 唤醒词相关 ----
  _wakeWordResponse: false,  // 标记：当前说话是唤醒词回复，结束后直接进入LISTENING
  _manualInterrupt: false,   // 标记：手动打断，结束后直接进入LISTENING
  _isApologyResponse: false, // 标记：当前说话是"抱歉"回复，允许停止命令绕过冷却期打断
  _speakStartTime: 0,        // 说话开始时间戳（用于冷却期，避免TTS回声触发唤醒词）

  // ---- 空闲超时 ----
  _idleTimer: null,          // 空闲计时器（LISTENING状态下无输入超时进入STANDBY）
  _idleTimeout: 10000,       // 空闲超时时间（毫秒）

  // ---- 嘴部动画 ----
  _mouthTimer: null,    // 嘴部交替切换定时器
  _mouthToggle: false,  // 当前显示哪张图片（false=00待机, true=01张嘴）
  _mouthSpeed: 200,     // 切换速度（毫秒），值越小切换越快

  // ---- DOM 元素 ----
  el: {},

  // ==================== 初始化 ====================

  init() {
    // 缓存 DOM 元素
    this.el = {
      app:           document.getElementById('app'),
      bgWipe:        document.getElementById('bg-wipe'),
      startBtn:      document.getElementById('start-btn'),
      charArea:      document.getElementById('character-area'),
      speakOverlay:  document.getElementById('speak-overlay'),
      charName:      document.getElementById('character-name'),
      charTheme:     document.getElementById('character-theme'),
      subtitleBar:   document.getElementById('subtitle-bar'),
      subtitleText:  document.getElementById('subtitle-text'),
      voiceStatus:   document.getElementById('voice-status'),
      statusIcon:    document.getElementById('status-icon'),
      statusText:    document.getElementById('status-text'),
      charSelector:  document.getElementById('character-selector'),
      interimText:   document.getElementById('interim-text'),
      warning:       document.getElementById('warning'),
      interruptBtn:  document.getElementById('interrupt-btn'),
      introVideo:    document.getElementById('intro-video'),
      introVideoWrap: document.getElementById('intro-video-wrap'),
      introSkip:     document.getElementById('intro-skip'),
      yuebaiEntranceVideo: document.getElementById('entrance-video'),
      yuebaiEntranceWrap:  document.getElementById('entrance-video-wrap')
    };

    // 渲染角色选择按钮
    this._renderCharSelector();

    // 绑定启动按钮
    this.el.startBtn.addEventListener('click', () => this.start());

    // 绑定打断按钮
    this.el.interruptBtn.addEventListener('click', () => this._interruptSpeech());

    // 绑定键盘快捷键（调试用）
    document.addEventListener('keydown', (e) => {
      if (e.key >= '1' && e.key <= '5') {
        const idx = parseInt(e.key) - 1;
        if (idx < CHARACTERS.length) {
          this.switchCharacter(CHARACTERS[idx].id);
        }
      }
      if (e.key === ' ') {
        e.preventDefault();
        if (this.state === 'SPEAKING') {
          this._interruptSpeech();
        }
      }
    });

    // 初始化语音模块
    VoiceManager.init();

    // 设置语音回调
    this._setupVoiceCallbacks();

    // 检测兼容性
    if (!VoiceManager.isSupported) {
      this._showWarning('当前浏览器不支持语音识别，请使用 Chrome 或 Edge 浏览器。可点击下方角色按钮进行操作。');
    }

    // 开场视频处理
    this._setupIntroVideo();
  },

  // ==================== 启动 ====================

  start() {
    // 隐藏开场视频层（定格画面 + 开始按钮）
    this.el.introVideoWrap.classList.add('hidden');

    // 默认显示悦白
    this.currentChar = CHARACTERS[0];
    this.charIndex = 0;
    this._updateDisplay(this.currentChar);

    // 启动STT（待机状态下监听唤醒词；说话期间会自动停止）
    VoiceManager.startListening();

    // 播放入场动画，视频结束后再显示角色并说开场白
    this._playEntranceVideo(this.currentChar, () => this._showCharacterAndGreet());
  },

  /**
   * 播放角色入场动画视频，播放完毕后回调
   * 视频结束 → 定格最后一帧 → 淡出过渡 → 回调（显示角色图片）
   * @param {object} char — 角色对象（需含 entranceVideo 字段）
   * @param {function} callback — 视频结束后的回调
   */
  _playEntranceVideo(char, callback) {
    const video = this.el.yuebaiEntranceVideo;
    const wrap = this.el.yuebaiEntranceWrap;

    // 没有视频元素或该角色没有入场视频，直接回调
    if (!video || !wrap || !char.entranceVideo) {
      callback();
      return;
    }

    // 设置视频源并重置状态
    video.src = char.entranceVideo;
    video.currentTime = 0;
    wrap.classList.remove('fading-out');
    wrap.classList.add('playing');

    // 播放结束后的处理：定格最后一帧 → 淡出 → 回调
    const onVideoEnd = () => {
      video.removeEventListener('ended', onVideoEnd);
      video.pause(); // 定格在最后一帧

      // 淡出揭示下方图片（0.4s）
      wrap.classList.add('fading-out');
      setTimeout(() => {
        wrap.classList.remove('playing');
        wrap.classList.remove('fading-out');
        callback();
      }, 400);
    };

    video.addEventListener('ended', onVideoEnd);

    // 尝试播放（带自动播放失败降级处理）
    const playPromise = video.play();
    if (playPromise) {
      playPromise.catch(() => {
        // 自动播放被阻止，静音后重试
        video.muted = true;
        video.play().catch(() => {
          // 仍然失败，直接跳过视频
          video.removeEventListener('ended', onVideoEnd);
          wrap.classList.remove('playing');
          wrap.classList.remove('fading-out');
          callback();
        });
      });
    }
  },

  /**
   * 入场视频结束后直接播放开场白
   */
  _showCharacterAndGreet() {
    this._narrate(this.currentChar, 'all');
  },

  // ==================== 语音回调设置 ====================

  _setupVoiceCallbacks() {
    // 识别到最终文本
    VoiceManager.onRecognize = (text) => {
      console.log('[App] 识别到:', text, '| 状态:', this.state);
      this.el.interimText.textContent = '';
      this._resetIdleTimer(); // 有识别结果，重置空闲计时
      this.processVoiceInput(text);
    };

    // 临时识别结果（仅在LISTENING状态显示）
    VoiceManager.onInterim = (text) => {
      if (this.state === 'LISTENING') {
        this.el.interimText.textContent = text;
        this._resetIdleTimer(); // 有临时结果，重置空闲计时
      }
    };

    // 字幕更新
    VoiceManager.onSubtitle = (text) => {
      this._showSubtitle(text);
    };

    // 开始说话（设置状态和显示打断按钮，但不启动嘴部动画）
    VoiceManager.onSpeakStart = () => {
      this._setState('SPEAKING');
      this._speakStartTime = Date.now();
      // 说话期间停止监听，避免麦克风拾取网页TTS输出的回声导致识别错误
      // 用户可点击打断按钮中止说话，打断后会自动恢复监听
      VoiceManager.stopListening();
    };

    // 单句语音实际开始播放时才启动嘴部动画
    VoiceManager.onUtteranceStart = () => {
      this._startMouthAnimation();
      this._speakStartTime = Date.now(); // 更新冷却时间戳
    };

    // 说话结束
    VoiceManager.onSpeakEnd = () => {
      this._onSpeakEnd();
    };

    // 麦克风结束
    VoiceManager.onListenEnd = () => {
      this.el.statusIcon.classList.remove('listening');
      if (this.state === 'LISTENING') {
        this.el.statusText.textContent = '聆听中';
      }
      // STANDBY 状态保持"待机中"文字
    };

    // 麦克风开始
    VoiceManager.onListenStart = () => {
      if (this.state === 'LISTENING') {
        this.el.statusIcon.classList.add('listening');
        this.el.statusText.textContent = '正在聆听...';
        if (!this.el.interimText.textContent) {
          this.el.interimText.textContent = '🎤 请说出你的问题...';
        }
      }
      // STANDBY 状态不更新UI，保持"待机中"
    };

    // 语音加载完成（在线Neural/童声）
    VoiceManager.onVoiceReady = (voice, isChild, isOnline) => {
      if (isOnline) {
        console.log('[App] 语音就绪:', voice.name, isChild ? '童声' : '在线Neural');
      }
    };

    // 未找到在线Neural语音，提示用户
    VoiceManager.onVoiceWarning = (voice) => {
      this._showWarning(
        '当前使用的是系统本地语音（' + voice.name + '），音质一般。\n' +
        '推荐使用 Microsoft Edge 浏览器并确保已启用"在线语音"：\n' +
        'Edge 设置 → 语言和内容 → 打开"在线语音"功能，即可获得童趣自然语音。'
      );
    };
  },

  // ==================== 语音输入处理 ====================

  processVoiceInput(text) {
    // 特殊处理：在"抱歉"回复期间，允许停止命令绕过冷却期打断
    if (this.state === 'SPEAKING' && this._isApologyResponse && this._matchCommand(text, 'stop') && text.length <= 6) {
      console.log('[App] "抱歉"回复期间检测到停止命令，允许打断:', text);
      this._isApologyResponse = false;
      VoiceManager.stopSpeaking();
      this._onSpeakEnd();
      return;
    }

    // 说话冷却期内忽略STT结果（避免TTS回声触发唤醒词）
    // 每句TTS开始时更新时间戳，冷却期覆盖整个说话过程
    if (this.state === 'SPEAKING' && this._speakStartTime && Date.now() - this._speakStartTime < 2500) {
      console.log('[App] 说话冷却期内，忽略STT结果:', text);
      return;
    }

    // 1. 唤醒词检测（在 SPEAKING 和 STANDBY 状态下触发唤醒）
    // SPEAKING状态下，唤醒词文本必须很短（≤6字），过滤TTS回声中偶然包含的"你好"
    if ((this.state === 'SPEAKING' || this.state === 'STANDBY') && this._matchCommand(text, 'wake')) {
      if (this.state === 'SPEAKING' && text.length > 6) {
        console.log('[App] SPEAKING状态下唤醒词文本过长，疑似TTS回声，忽略:', text);
        return;
      }
      this._handleWakeWord(text);
      return;
    }

    // 2. 停止命令（在 SPEAKING 状态下可以停止说话）
    // 同样要求短文本，避免TTS回声中包含"停"等字触发误中断
    if (this.state === 'SPEAKING' && this._matchCommand(text, 'stop')) {
      if (text.length > 6) {
        console.log('[App] SPEAKING状态下停止命令文本过长，疑似TTS回声，忽略:', text);
        return;
      }
      VoiceManager.stopSpeaking();
      this._onSpeakEnd();
      return;
    }

    // 3. 其他输入只在 LISTENING 状态处理（SPEAKING状态下的长文本一律忽略）
    if (this.state !== 'LISTENING') return;

    // 在 LISTENING 状态下，如果文本包含唤醒词，去掉唤醒词后处理剩余部分
    let processedText = text;
    if (this._matchCommand(text, 'wake')) {
      processedText = this._stripWakeWord(text);
      if (!processedText || processedText.length < 2) {
        // 只说了"你好"，提示用户提问
        // 设置标记：回复结束后直接进入LISTENING（不进入STANDBY）
        this._wakeWordResponse = true;
        this._showSubtitle('嗯，我在~');
        VoiceManager.speak('嗯，我在~', this.currentChar.voice);
        return;
      }
    }

    // 4. 检查停止命令（在 LISTENING 状态下进入待机）
    if (this._matchCommand(processedText, 'stop')) {
      VoiceManager.stopSpeaking();
      this._onSpeakEnd();
      return;
    }

    if (this._matchCommand(processedText, 'next')) {
      const nextIdx = (this.charIndex + 1) % CHARACTERS.length;
      this.switchCharacter(CHARACTERS[nextIdx].id);
      return;
    }

    if (this._matchCommand(processedText, 'prev')) {
      const prevIdx = (this.charIndex - 1 + CHARACTERS.length) % CHARACTERS.length;
      this.switchCharacter(CHARACTERS[prevIdx].id);
      return;
    }

    if (this._matchCommand(processedText, 'repeat')) {
      this._narrate(this.currentChar, 'sections');
      return;
    }

    if (this._matchCommand(processedText, 'home') || this._matchCommand(processedText, 'yuebai')) {
      this.switchCharacter('yuebai');
      return;
    }

    // 5. 知识库问答匹配（优先于主题关键词，确保用户提问能被准确回答，
    //    而不是被"实践营""大陈岛""垦荒精神"等主题词拦截触发角色切换）
    const kbResult = this._matchKnowledgeBase(processedText);
    if (kbResult) {
      // 如果回答角色与当前角色不同，先切换角色再回答（直接回答问题，不说greeting开场白）
      if (kbResult.charId && kbResult.charId !== this.currentChar.id) {
        const targetChar = CHARACTERS.find(c => c.id === kbResult.charId);
        if (targetChar) {
          this._switchAndAnswer(targetChar, kbResult.answer);
          return;
        }
      }
      // 用当前角色回答
      VoiceManager.speak(kbResult.answer, this.currentChar.voice);
      return;
    }

    // 6. 检查角色名（三字以上的关键词，如"白小智""白小垦"等完整角色名，
    //    或未命中知识库的主题词，此时视为切换主题）
    for (const char of CHARACTERS) {
      for (const keyword of char.keywords) {
        if (keyword.length >= 3 && processedText.includes(keyword)) {
          if (char.id === this.currentChar.id) {
            // 已在当前角色，重新讲解
            this._narrate(this.currentChar, 'sections');
          } else {
            this.switchCharacter(char.id);
          }
          return;
        }
      }
    }

    // 7. 两字角色名匹配（知识库未匹配到时，再检查两字关键词）
    for (const char of CHARACTERS) {
      for (const keyword of char.keywords) {
        if (keyword.length === 2 && processedText.includes(keyword)) {
          if (char.id === this.currentChar.id) {
            this._narrate(this.currentChar, 'sections');
          } else {
            this.switchCharacter(char.id);
          }
          return;
        }
      }
    }

    // 8. 单字角色名兜底匹配
    for (const char of CHARACTERS) {
      for (const keyword of char.keywords) {
        if (keyword.length === 1 && processedText.includes(keyword)) {
          if (char.id === this.currentChar.id) {
            this._narrate(this.currentChar, 'sections');
          } else {
            this.switchCharacter(char.id);
          }
          return;
        }
      }
    }

    // 9. 未匹配 — 给出提示
    this._isApologyResponse = true;
    this._showSubtitle('抱歉，我没有听清楚呢。你可以说出小伙伴的名字切换主题，或者问我关于白云街道的问题哦！');
    VoiceManager.speak(
      '抱歉，我没有听清楚呢。你可以说出小伙伴的名字切换主题，或者问我关于白云街道的问题哦！',
      this.currentChar.voice
    );
  },

  /**
   * 处理唤醒词：中断说话或取消待机，切换到监听状态
   * 支持"你好+角色名"一句话完成唤醒+切换
   */
  _handleWakeWord(text) {
    console.log('[App] 唤醒词检测到！');

    // 如果正在说话，先停止
    if (this.state === 'SPEAKING') {
      VoiceManager.stopSpeaking();
      this._stopMouthAnimation();
    }

    // 去除唤醒词，提取剩余内容
    const remaining = this._stripWakeWord(text);

    if (remaining && remaining.length >= 2) {
      // 用户在说唤醒词的同时也说了更多内容
      // 优先检查知识库问答（确保提问能被准确回答，而不是被主题词拦截切换角色）
      const kbResult = this._matchKnowledgeBase(remaining);
      if (kbResult) {
        if (kbResult.charId && kbResult.charId !== this.currentChar.id) {
          const targetChar = CHARACTERS.find(c => c.id === kbResult.charId);
          if (targetChar) {
            this._setState('LISTENING');
            this._switchAndAnswer(targetChar, kbResult.answer);
            return;
          }
        }
        this._setState('LISTENING');
        VoiceManager.speak(kbResult.answer, this.currentChar.voice);
        return;
      }

      // 检查是否包含三字以上的角色名（如"白小智""白小垦"等完整角色名，或未命中知识库的主题词）
      for (const char of CHARACTERS) {
        for (const keyword of char.keywords) {
          if (keyword.length >= 3 && remaining.includes(keyword)) {
            // 命中角色名，直接切换角色（唤醒+切换一步到位）
            console.log('[App] 唤醒词+角色名：', char.name);
            this.switchCharacter(char.id);
            return;
          }
        }
      }

      // 检查是否包含停止命令
      if (this._matchCommand(remaining, 'stop')) {
        this._setState('LISTENING');
        this._onSpeakEnd();
        return;
      }

      // 两字角色名匹配（知识库未匹配到时）
      for (const char of CHARACTERS) {
        for (const keyword of char.keywords) {
          if (keyword.length === 2 && remaining.includes(keyword)) {
            console.log('[App] 唤醒词+两字角色名：', char.name);
            this.switchCharacter(char.id);
            return;
          }
        }
      }

      // 单字角色名兜底匹配
      for (const char of CHARACTERS) {
        for (const keyword of char.keywords) {
          if (keyword.length === 1 && remaining.includes(keyword)) {
            console.log('[App] 唤醒词+单字角色名：', char.name);
            this.switchCharacter(char.id);
            return;
          }
        }
      }

      // 剩余内容未匹配到角色或知识库，进入监听并处理
      this._setState('LISTENING');
      this.el.interimText.textContent = '';
      this.processVoiceInput(remaining);
    } else {
      // 只说了唤醒词，切换到监听状态并回复
      this._setState('LISTENING');
      this._showSubtitle('嗯，我在~');
      // 设置标记：唤醒回复结束后直接进入LISTENING（不进入STANDBY）
      this._wakeWordResponse = true;
      VoiceManager.speak('嗯，我在~', this.currentChar.voice);
    }
  },

  /**
   * 从文本中去除唤醒词及其附近的语气词
   */
  _stripWakeWord(text) {
    let result = text;
    if (COMMANDS.wake) {
      // 按长度降序排列，先匹配长词
      const sortedWake = [...COMMANDS.wake].sort((a, b) => b.length - a.length);
      for (const wake of sortedWake) {
        result = result.split(wake).join('');
      }
    }
    // 去除开头的语气词和标点
    return result.trim().replace(/^[，,。.！!？?\s呀啊哦呢吧嘛哈]+/, '').trim();
  },

  /**
   * 切换角色后回答知识库问题
   */
  _switchAndAnswer(char, answer) {
    VoiceManager.stopSpeaking();
    this._stopMouthAnimation();
    this._setState('TRANSITIONING');
    this.charIndex = CHARACTERS.indexOf(char);
    this.currentChar = char;
    this._updateCharSelector();
    this.el.charArea.classList.add('switching');

    // 触发背景擦除切换
    this._switchBackground(char.bg);

    setTimeout(() => {
      this._updateDisplay(char);

      // 播放入场动画，结束后显示角色并回答问题
      this._playEntranceVideo(char, () => {
        this.el.charArea.classList.remove('switching');
        setTimeout(() => {
          VoiceManager.speak(answer, char.voice);
        }, 400);
      });
    }, 400);
  },

  /**
   * 知识库匹配：遍历知识库，找到第一个匹配的问答
   * @param {string} text — 用户输入文本
   * @returns {object|null} — { answer, charId } 或 null
   */
  _matchKnowledgeBase(text) {
    if (typeof KNOWLEDGE_BASE === 'undefined') {
      console.warn('[KB] KNOWLEDGE_BASE 未定义!');
      return null;
    }
    console.log('[KB] 匹配文本:', text);
    for (const item of KNOWLEDGE_BASE) {
      // keywords 是二维数组，每个子数组是一组"且"关系的关键词
      // 任意一组全部匹配即命中
      for (const group of item.keywords) {
        if (group.every(kw => text.includes(kw))) {
          console.log('[KB] 命中:', group, '→ charId:', item.charId);
          return { answer: item.answer, charId: item.charId || null };
        }
      }
    }
    console.log('[KB] 未命中，将走角色关键词匹配');
    return null;
  },

  _matchCommand(text, cmdKey) {
    return COMMANDS[cmdKey] && COMMANDS[cmdKey].some(kw => text.includes(kw));
  },

  // ==================== 角色切换 ====================

  /**
   * 背景擦除切换：新背景从上到下覆盖旧背景
   * @param {string} bgUrl — 新背景图路径
   */
  _switchBackground(bgUrl) {
    if (!bgUrl) return;
    if (!this.el.app) return;

    // 如果擦除层不存在，直接切换背景（兼容降级）
    if (!this.el.bgWipe) {
      this.el.app.style.backgroundImage = `url('${bgUrl}')`;
      return;
    }

    // 设置擦除层为新背景图
    this.el.bgWipe.style.backgroundImage = `url('${bgUrl}')`;

    // 重置动画（移除再添加类名，确保动画重新触发）
    this.el.bgWipe.classList.remove('wiping');
    void this.el.bgWipe.offsetWidth; // 强制重排
    this.el.bgWipe.classList.add('wiping');

    // 动画结束后（0.8s），把新背景设为主背景，隐藏擦除层
    setTimeout(() => {
      this.el.app.style.backgroundImage = `url('${bgUrl}')`;
      this.el.bgWipe.classList.remove('wiping');
      this.el.bgWipe.style.clipPath = 'inset(0 0 100% 0)';
    }, 800);
  },

  switchCharacter(charId, skipGreeting = false) {
    const char = CHARACTERS.find(c => c.id === charId);
    if (!char) return;

    // 停止当前语音和嘴部动画
    VoiceManager.stopSpeaking();
    this._stopMouthAnimation();

    this._setState('TRANSITIONING');
    this.charIndex = CHARACTERS.indexOf(char);
    this.currentChar = char;

    // 更新角色选择高亮
    this._updateCharSelector();

    // 淡出当前角色
    this.el.charArea.classList.add('switching');

    // 触发背景擦除切换
    this._switchBackground(char.bg);

    // 在擦除动画进行到一半时切换角色图片，然后播放入场动画
    setTimeout(() => {
      this._updateDisplay(char);

      // 播放入场动画，结束后显示角色并播放讲解
      this._playEntranceVideo(char, () => {
        this.el.charArea.classList.remove('switching');
        // 播放讲解：默认说greeting+sections+prompt(切换角色时触发开场白)；
        // skipGreeting=true 时只说 sections（仅用于"重复讲解"等不需要开场的场景）
        setTimeout(() => {
          this._narrate(char, skipGreeting ? 'sections' : 'all');
        }, 500);
      });
    }, 400);
  },

  // ==================== 讲解流程 ====================

  /**
   * 播报角色内容
   * @param {object} char — 角色对象
   * @param {string} mode — 'greeting' | 'sections' | 'prompt' | 'all'
   */
  _narrate(char, mode = 'all') {
    let lines = [];

    if (mode === 'greeting') {
      lines = [char.greeting];
    } else if (mode === 'sections') {
      lines = [...char.sections];
    } else if (mode === 'prompt') {
      lines = [char.prompt];
    } else {
      // all: greeting + sections + prompt
      lines = [char.greeting, ...char.sections, char.prompt];
    }

    VoiceManager.speak(lines, char.voice);
  },

  _onSpeakEnd() {
    // 停止嘴部动画，切回待机图片（00）
    this._stopMouthAnimation();
    // 重置"抱歉"回复标记
    this._isApologyResponse = false;

    // 如果是唤醒词回复或手动打断，直接进入监听状态（不进入待机）
    if (this._wakeWordResponse || this._manualInterrupt) {
      this._wakeWordResponse = false;
      this._manualInterrupt = false;
      this._setState('LISTENING');
      this._showSubtitle(this.currentChar.prompt || '请说出你想了解的主题...');
    } else {
      // 正常讲解结束，进入待机状态，等待唤醒词
      this._setState('STANDBY');
      this._showSubtitle('说"你好"唤醒我吧~');
    }
  },

  // ==================== UI 更新 ====================

  _updateDisplay(char) {
    // 设置主背景（待机图，闭嘴）
    this.el.app.style.backgroundImage = `url('${char.image}')`;
    // 设置说话覆盖层背景（张嘴图）
    this.el.speakOverlay.style.backgroundImage = `url('${char.imageSpeak || char.image}')`;
    this.el.charName.textContent = char.name;
    this.el.charTheme.textContent = char.theme;

    // 更新主题色
    document.documentElement.style.setProperty('--accent', char.accent);

    // 更新角色选择高亮
    this._updateCharSelector();
  },

  /**
   * 启动嘴部动画：00（闭嘴）和01（张嘴）交替切换
   * 使用双图层叠加 + opacity 切换，避免 src 切换导致的闪烁
   */
  _startMouthAnimation() {
    this._stopMouthAnimation();
    // 确保说话覆盖层已加载正确图片
    this.el.speakOverlay.style.backgroundImage = `url('${this.currentChar.imageSpeak || this.currentChar.image}')`;
    // 显示打断按钮
    this.el.interruptBtn.classList.remove('hidden');

    this._mouthToggle = false;
    this._mouthTimer = setInterval(() => {
      this._mouthToggle = !this._mouthToggle;
      // 通过opacity切换显示张嘴/闭嘴图
      this.el.speakOverlay.style.opacity = this._mouthToggle ? '1' : '0';
    }, this._mouthSpeed);
  },

  /**
   * 停止嘴部动画，切回00待机图片
   */
  _stopMouthAnimation() {
    if (this._mouthTimer) {
      clearInterval(this._mouthTimer);
      this._mouthTimer = null;
    }
    this._mouthToggle = false;
    this.el.speakOverlay.style.opacity = '0';
    // 隐藏打断按钮
    this.el.interruptBtn.classList.add('hidden');
  },

  /**
   * 打断当前说话，手动打断后直接进入监听状态
   */
  _interruptSpeech() {
    VoiceManager.stopSpeaking();
    this._manualInterrupt = true;
    this._onSpeakEnd();
  },

  _showSubtitle(text) {
    this.el.subtitleText.textContent = text;
    // 重新触发动画
    this.el.subtitleText.classList.remove('fade-in');
    void this.el.subtitleText.offsetWidth; // 强制重排
    this.el.subtitleText.classList.add('fade-in');
  },

  _setState(state) {
    const prevState = this.state;
    this.state = state;
    console.log('[App] 状态切换:', prevState, '→', state);

    // 离开 LISTENING 状态时停止空闲计时
    if (prevState === 'LISTENING' && state !== 'LISTENING') {
      this._stopIdleTimer();
    }

    // 更新状态指示器
    switch (state) {
      case 'SPEAKING':
        this.el.statusIcon.className = 'speaking';
        this.el.statusText.textContent = '讲解中';
        this.el.subtitleBar.classList.add('active');
        this.el.interimText.textContent = '';
        break;
      case 'LISTENING':
        this.el.statusIcon.className = '';
        this.el.statusText.textContent = '聆听中';
        this.el.subtitleBar.classList.remove('active');
        this.el.interimText.textContent = '';
        VoiceManager.startListening();
        this._startIdleTimer(); // 进入监听状态，启动空闲计时
        break;
      case 'STANDBY':
        this.el.statusIcon.className = 'standby';
        this.el.statusText.textContent = '待机中';
        this.el.subtitleBar.classList.remove('active');
        this.el.interimText.textContent = '';
        // 待机状态下保持STT运行，用于检测唤醒词
        VoiceManager.startListening();
        break;
      case 'TRANSITIONING':
        this.el.statusIcon.className = '';
        this.el.statusText.textContent = '切换中...';
        break;
      case 'IDLE':
        this.el.statusText.textContent = '';
        break;
    }
  },

  _renderCharSelector() {
    this.el.charSelector.innerHTML = '';
    CHARACTERS.forEach((char, idx) => {
      const btn = document.createElement('button');
      btn.className = 'char-btn';
      btn.dataset.charId = char.id;
      btn.title = `${char.name} — ${char.theme}`;

      const img = document.createElement('img');
      img.src = char.thumb || char.image;
      img.alt = char.name;
      btn.appendChild(img);

      const label = document.createElement('span');
      label.className = 'char-btn-label';
      label.textContent = char.name;
      btn.appendChild(label);

      btn.addEventListener('click', () => {
        if (this.state === 'IDLE') return;
        this.switchCharacter(char.id);  // 点击角色栏触发，说greeting开场白
      });

      this.el.charSelector.appendChild(btn);
    });
  },

  _updateCharSelector() {
    const buttons = this.el.charSelector.querySelectorAll('.char-btn');
    buttons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.charId === this.currentChar?.id);
    });
  },

  /**
   * 启动空闲计时器：LISTENING状态下超过10秒无语音输入，自动进入STANDBY
   */
  _startIdleTimer() {
    this._stopIdleTimer();
    this._idleTimer = setTimeout(() => {
      if (this.state === 'LISTENING') {
        console.log('[App] 空闲超时，自动进入待机状态');
        this._showSubtitle('我 先休息一下，需要我的时候说"你好"唤醒哦~');
        this._setState('STANDBY');
      }
    }, this._idleTimeout);
  },

  _stopIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  },

  _resetIdleTimer() {
    if (this.state === 'LISTENING' && this._idleTimer) {
      this._startIdleTimer(); // 重新计时
    }
  },

  /**
   * 开场视频处理：自动播放，播放结束或点击跳过后定格在最后一帧并显示开始按钮
   */
  _setupIntroVideo() {
    const video = this.el.introVideo;
    const wrap = this.el.introVideoWrap;
    const skipBtn = this.el.introSkip;

    if (!video || !wrap) {
      // 没有视频元素，直接显示开始按钮
      if (this.el.startBtn) this.el.startBtn.classList.remove('hidden');
      return;
    }

    // 尝试自动播放（浏览器可能阻止带音视频的自动播放）
    const playPromise = video.play();
    if (playPromise) {
      playPromise.catch(() => {
        // 自动播放被阻止，静音后重试
        video.muted = true;
        video.play().catch(() => {
          // 仍然失败，直接显示开始按钮
          this._endIntroVideo();
        });
      });
    }

    // 视频播放结束 — 定格在最后一帧，显示开始按钮
    video.addEventListener('ended', () => {
      this._endIntroVideo();
    });

    // 点击跳过 — 跳到最后一帧并显示开始按钮
    if (skipBtn) {
      skipBtn.addEventListener('click', () => {
        // 跳到视频末尾并暂停（定格最后一帧）
        video.currentTime = video.duration || 0;
        video.pause();
        this._endIntroVideo();
      });
    }
  },

  /**
   * 视频结束：定格在最后一帧，隐藏跳过按钮，显示开始按钮
   */
  _endIntroVideo() {
    // 隐藏跳过按钮
    if (this.el.introSkip) {
      this.el.introSkip.classList.add('hidden');
    }
    // 显示开始按钮（直接叠加在视频定格画面上）
    if (this.el.startBtn) {
      this.el.startBtn.classList.remove('hidden');
    }
  },

  _showWarning(msg) {
    if (this.el.warning) {
      this.el.warning.textContent = msg + '\n\n（点击此处关闭提示）';
      this.el.warning.classList.remove('hidden');
      // 点击关闭警告
      this.el.warning.onclick = () => {
        this.el.warning.classList.add('hidden');
      };
    }
  }
};

// ==================== 启动 ====================
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
