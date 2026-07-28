export interface Translations {
    // Nav
    dashboard: string;
    logsExplorer: string;
    stepRecorder: string;
    credentials: string;
    systemStatus: string;
    settings: string;
    signOut: string;
    controlPanel: string;
    // Layout header
    systemOnline: string;
    browser: string;
    paused: string;
    live: string;
    idle: string;
    // Home
    newMission: string;
    activeConfigurations: string;
    runningNow: string;
    successLast24h: string;
    failedLast24h: string;
    needsAttention: string;
    totalJobs: string;
    inQueue: string;
    sevenDayHistory: string;
    dashboardSubtitle: string;
    successVsFailure: string;
    clickToFilter: string;
    clickToReset: string;
    failedToUpdate: string;
    filterEmptyNeedsAttention: string;
    filterEmptyRunning: string;
    filterEmptySuccess: string;
    filterEmptyFailed: string;
    showAllTasks: string;
    reset: string;
    showing: string;
    blockedTasks: string;
    // Task actions
    run: string;
    retry: string;
    cancel: string;
    enable: string;
    disable: string;
    // Toast
    taskTriggered: string;
    taskTriggeredDesc: string;
    failedToTrigger: string;
    taskEnabled: string;
    taskEnabledDesc: string;
    taskDisabled: string;
    taskDisabledDesc: string;
    cloneTask: string;
    taskCloned: string;
    taskClonedDesc: string;
    failedToClone: string;
    backup: string;
    exportTasks: string;
    exportTemplates: string;
    importTasks: string;
    tasksImported: string;
    failedToImport: string;
    searchTasks: string;
    cancelRequested: string;
    cancelRequestedDesc: string;
    // Status
    neverRun: string;
    // Misc
    loading: string;
    noTasks: string;
    nextIn: string;
    // StatusBadge
    statusSuccess: string;
    statusFailed: string;
    statusRunning: string;
    statusQueued: string;
    statusNeedsAttention: string;
    // TaskForm
    newTask: string;
    editTask: string;
    taskName: string;
    taskNamePlaceholder: string;
    targetUrl: string;
    targetUrlPlaceholder: string;
    schedule: string;
    noSchedule: string;
    cronExpression: string;
    randomSchedule: string;
    afterCompletion: string;
    browserConfig: string;
    enableBrowserConfig: string;
    provider: string;
    wsEndpoint: string;
    proxy: string;
    stealthMode: string;
    blockAds: string;
    ignoreHTTPS: string;
    sessionTimeout: string;
    workflowSteps: string;
    addStep: string;
    saveTask: string;
    saving: string;
    taskCreated: string;
    taskUpdated: string;
    failedToSave: string;
    failedToLoad: string;
    stepsImported: string;
    randomWindow: string;
    timesPerCycle: string;
    afterCompletionDesc: string;
    // TaskDetail
    editTask2: string;
    deleteTask: string;
    confirmDelete: string;
    confirmDeleteDesc: string;
    confirmDeleteBtn: string;
    taskNotFound: string;
    taskDeleted: string;
    failedToDelete: string;
    enabled: string;
    disabled: string;
    lastRun: string;
    nextRun: string;
    runHistory: string;
    noLogs: string;
    viewLog: string;
    taskConfig: string;
    browserProvider: string;
    runTaskNow: string;
    taskCancelled: string;
    failedToCancel: string;
    updatedAgo: string;
    runningStream: string;
    // LogDetail
    backToTask: string;
    executionLog: string;
    startedAt: string;
    duration: string;
    steps: string;
    noLogData: string;
    // LogsExplorer
    allTasks: string;
    filterByTask: string;
    filterByStatus: string;
    allStatuses: string;
    noLogsFound: string;
    task: string;
    date: string;
    status: string;
    // Credentials
    addCredential: string;
    editCredential: string;
    credentialName: string;
    username: string;
    password: string;
    totp: string;
    totpPlaceholder: string;
    saveCredential: string;
    deleteCredential: string;
    confirmDeleteCred: string;
    confirmDeleteCredDesc: string;
    credentialSaved: string;
    credentialUpdated: string;
    credentialDeleted: string;
    failedToSaveCred: string;
    failedToDeleteCred: string;
    noCredentials: string;
    // Settings
    retentionSettings: string;
    logRetentionDays: string;
    logRetentionDesc: string;
    maxScreenshotStorage: string;
    maxScreenshotDesc: string;
    runCleanupNow: string;
    retentionSaved: string;
    cleanupComplete: string;
    cleanupCompleteDesc: string;
    cleanupFailed: string;
    saveFailed: string;
    networkError: string;
    pollingInterval: string;
    pollingIntervalDesc: string;
    changePassword: string;
    currentPassword: string;
    newPassword: string;
    repeatPassword: string;
    passwordChanged: string;
    passwordChangeFailed: string;
    wrongPassword: string;
    passwordMismatch: string;
    taskTimeout: string;
    taskTimeoutDesc: string;
    timeoutDisabled: string;
    timeoutCustom: string;
    timeoutMinutes: string;
    captchaSettings: string;
    captchaProvider: string;
    noCaptcha: string;
    captchaSaved: string;
    aboutSystem: string;
    version: string;
    uptime: string;
    database: string;
    dbConnected: string;
    dbError: string;
    systemInfoFailed: string;
    browserSettings: string;
    testConnection: string;
    connectionOk: string;
    connectionFailed: string;
    browserSettingsSaved: string;
    // Status page
    allSystemsOk: string;
    systemsDegraded: string;
    taskScheduler: string;
    browserService: string;
    // Login / Setup
    signIn: string;
    enterPassword: string;
    invalidPassword: string;
    setupTitle: string;
    setupDesc: string;
    repeatPasswordPlaceholder: string;
    setPassword: string;
    settingUp: string;
    // Recorder
    stepRecorderTitle: string;
    startSession: string;
    stopSession: string;
    takeScreenshot: string;
    copySteps: string;
    loadToForm: string;
    clearSteps: string;
    enterUrl: string;
    startingBrowser: string;
    sessionActive: string;
    noStepsYet: string;
    stepsCopied: string;
    stepsLoaded: string;
    screenshotTaken: string;
    failedToStart: string;
    // not-found
    pageNotFound: string;
    pageNotFoundHint: string;
      // TaskDetail
      returnToDashboard: string;
      stopThisTask: string;
      keepRunning: string;
      areYouSure: string;
      captchaDetected: string;
      loginStrategy: string;
      manualOnly: string;
      lastExecution: string;
      stopRequested: string;
      stopRequestedDesc: string;
      couldNotStop: string;
      failedToReachServer: string;
      alreadyRunning: string;
      alreadyRunningDesc: string;
      retryMission: string;
      postcheckScreenshot: string;
      // Settings
      advancedOptions: string;
      testUrl: string;
      platformConfig: string;
      intervalFastest: string;
      intervalBalanced: string;
      intervalSlower: string;
      platform: string;
      // Recorder
      startRecording: string;
      startingUrl: string;
      howItWorks: string;
      copiedLabel: string;
      copyJson: string;
      quickLabel: string;
      // LogDetail
      logNotFound: string;
      timestamp: string;
      result: string;
      executionScreenshot: string;
      stepScreenshot: string;
      copy: string;
      noStepLogs: string;
      finalScreenshot: string;
      dryRun: string;
      executionAborted: string;
      completedWithoutErrors: string;
      // Status
      schedulerError: string;
      apiServerError: string;
      dbQueryFailed: string;
      // StepEditor - step types
      stepLogin: string;
      stepLoginDesc: string;
      stepNavigate: string;
      stepNavigateDesc: string;
      stepClick: string;
      stepClickDesc: string;
      stepFill: string;
      stepFillDesc: string;
      stepSelectOpt: string;
      stepSelectOptDesc: string;
      stepScroll: string;
      stepScrollDesc: string;
      stepHover: string;
      stepHoverDesc: string;
      stepWait: string;
      stepWaitDesc: string;
      stepWaitFor: string;
      stepWaitForDesc: string;
      stepScreenshotType: string;
      stepScreenshotTypeDesc: string;
      stepSwitchTab: string;
      stepSwitchTabDesc: string;
      stepKeyPress: string;
      stepKeyPressDesc: string;
      stepCondition: string;
      stepConditionDesc: string;
      stepDismissPopups: string;
      stepDismissPopupsDesc: string;
      stepCfVerify: string;
      stepCfVerifyDesc: string;
      stepCfVerifyUrl: string;
      stepCfVerifyReloads: string;
      stepCfVerifyHint: string;
      // StepEditor - UI labels
      loginMethod: string;
      standardForm: string;
      loginPageUrl: string;
      useSavedCredential: string;
      enterInline: string;
      selectCredential: string;
      noSavedCredentials: string;
      successSelector: string;
      successText: string;
      ifCondition: string;
      textContains: string;
      textNotContains: string;
      elementVisible: string;
      elementNotVisible: string;
      urlContains: string;
      conditionValue: string;
      conditionSelector: string;
      thenExecute: string;
      moveUp: string;
      moveDown: string;
      dragToReorder: string;
      removeStep: string;
      importJson: string;
      clearAll: string;
      noStepsAdded: string;
      // ── Shared: profile / provider usage ──────────────────────────────────
      inUseByTasks: string;
      notInUse: string;
      deleteInUseWarning: string;
      andNMore: string;
      // ── Providers page ───────────────────────────────────────────────────
      providersIntro: string;
      addProvider: string;
      editProvider: string;
      noProvidersYet: string;
      checkAll: string;
      checkOne: string;
      healthCheckFailed: string;
      concurrencyLimit: string;
      concurrencyShort: string;
      liveRunningQueued: string;
      setAsDefault: string;
      defaultBadge: string;
      defaultProviderHint: string;
      urlHintCdp: string;
      urlHintSidecar: string;
      blockAdsLabel: string;
      ignoreHttpsErrors: string;
      blockWebrtcLabel: string;
      blockWebrtcHint: string;
      humanizeLabel: string;
      humanizeHint: string;
      sessionTimeoutMinutes: string;
      defaultResolution: string;
      resolutionHint: string;
      enabledLabel: string;
      disabledSuffix: string;
      deleteProviderTitle: string;
      deleteProviderDesc: string;
      providerSaved: string;
      providerUpdated: string;
      providerDeleted: string;
      tasksFellBackToDefault: string;
      nameAndUrlRequired: string;
      // ── Generic UI atoms ─────────────────────────────────────────────────
      fieldName: string;
      fieldType: string;
      actionSave: string;
      actionAdd: string;
      actionDelete: string;
      // ── Proxies page ─────────────────────────────────────────────────────
      proxiesTitle: string;
      proxiesIntro: string;
      addProxy: string;
      editProxy: string;
      noProxiesYet: string;
      proxyUrlLabel: string;
      proxyUrlHint: string;
      refreshExitAll: string;
      refreshExitOne: string;
      exitNotChecked: string;
      exitCheckFailed: string;
      exitCheckingInBackground: string;
      allProxiesRefreshed: string;
      failedToRefresh: string;
      proxySaved: string;
      proxyUpdated: string;
      proxyDeleted: string;
      deleteProxyTitle: string;
      deleteProxyDesc: string;
      tasksFellBackToNoProxy: string;
      nameAndProxyUrlRequired: string;
      // ── Fingerprints page ────────────────────────────────────────────────
      fingerprintsTitle: string;
      fingerprintsIntro: string;
      addFingerprint: string;
      editFingerprint: string;
      noFingerprintsYet: string;
      operatingSystem: string;
      generateFingerprint: string;
      generatedFixedOnSave: string;
      sourceBrowserforge: string;
      sourceRealPreset: string;
      generateHint: string;
      fingerprintGenerated: string;
      generateFailed: string;
      screenFixedByFingerprint: string;
      optionalSuffix: string;
      autoFromProxyIp: string;
      fingerprintSaved: string;
      fingerprintUpdated: string;
      fingerprintDeleted: string;
      deleteFingerprintTitle: string;
      deleteFingerprintDesc: string;
      tasksFellBackToDefaultFp: string;
      nameRequired: string;
      gpuLabel: string;
      screenLabel: string;
      platformLabel: string;
      cpuCoresLabel: string;
      // ── Dashboard run squares ────────────────────────────────────────────
      runDurationSuffix: string;
      last24hOnly: string;
      // ── Task groups / manual ordering ────────────────────────────────────
      newGroup: string;
      groupName: string;
      renameGroup: string;
      deleteGroupTitle: string;
      deleteGroupDesc: string;
      ungrouped: string;
      dragToReorderTasks: string;
      dragDisabledWhileFiltering: string;
      groupCreated: string;
      groupUpdated: string;
      groupDeleted: string;
      tasksUngrouped: string;
      orderSaved: string;
      failedToReorder: string;
      // ── Remaining pages ──────────────────────────────────────────────────
      resultsCount: string;
      enterValidUrl: string;
      tasksImportedDetail: string;
      tasksSkipped: string;
      fingerprintTip: string;
      fingerprintTipNone: string;
      screenshotExpired: string;
      credentialsIntro: string;
      hideValue: string;
      showValue: string;
      leaveEmptyToKeep: string;
      leaveEmptyKeepTotp: string;
      totpAutofillHint: string;
      timeoutSaved: string;
      captchaNoneHint: string;
      maxConcurrentSessions: string;
      maxQueueDepthLabel: string;
      queueWaitTimeout: string;
      concurrencyControl: string;
      backendMovedToProviders: string;
      goToProvidersPage: string;
      noneValue: string;
      defaultProviderIs: string;
      defaultProviderUnset: string;
      autoFollowExitIp: string;
      continueNextStep: string;
      exitTaskSuccess: string;
      exitTaskFailure: string;
      cookieOnlyMethod: string;
      requiredOneOfTwo: string;
      requiredSuffix: string;
      optionalSeedSuffix: string;
      successTextPlaceholder: string;
      successTextHint: string;
      cookieOnlyNeedsCriteria: string;
      cookieOnlyExplain: string;
      cookieModeLabel: string;
      cookieModeHint: string;
      sessionKeyHint: string;
      cookiePasteHint: string;
      whenConditionTrue: string;
      elseWhenFalse: string;
      timeoutMsLabel: string;
      dismissPopupsHint: string;
      taskNameRequired: string;
      targetUrlRequired: string;
      cookieOnlyNoCriterionTitle: string;
      cookieOnlyNoCriterionDesc: string;
      unitDays: string;
      unitHours: string;
      unitMinutes: string;
      unitTimes: string;
      unitEvery: string;
      randomWindowLabel: string;
      runsPerWindowLabel: string;
      randomScheduleHint: string;
      retryOnFailure: string;
      retryAfterFailure: string;
      retryTimesEvery: string;
      retryHint: string;
      webhookTrigger: string;
      webhookIntro: string;
      autoGeneratedPlaceholder: string;
      regenerate: string;
      webhookUseThisEdit: string;
      webhookUseThisNew: string;
      taskIdPlaceholder: string;
      webhookAuthHint: string;
      browserBackendSection: string;
      defaultShort: string;
      backendSectionHint: string;
      providerOptionLine: string;
      providerFieldHint: string;
      noDefaultProviderYet: string;
      proxyLabel: string;
      proxyNone: string;
      proxyWarpRotate: string;
      proxyCustom: string;
      proxySelectHint: string;
      proxyUrlPlaceholder: string;
      proxyCustomHint: string;
      warpRotationsLabel: string;
      warpRotationsPlaceholder: string;
      warpRotationsHint: string;
      fingerprintFieldLabel: string;
      fingerprintNoneReal: string;
      fingerprintHintCamoufox: string;
      fingerprintHintSb: string;
  }

  export const zh: Translations = {
    dashboard: "控制台",
    logsExplorer: "日志查询",
    stepRecorder: "操作录制",
    credentials: "凭证管理",
    systemStatus: "系统状态",
    settings: "设置",
    signOut: "退出登录",
    controlPanel: "控制面板",
    systemOnline: "系统运行中",
    browser: "浏览器",
    paused: "已暂停",
    live: "实时",
    idle: "空闲",
    newMission: "新建任务",
    activeConfigurations: "任务列表",
    runningNow: "运行中",
    successLast24h: "24h 成功",
    failedLast24h: "24h 失败",
    needsAttention: "需处理",
    totalJobs: "任务总数",
    sevenDayHistory: "7日运行记录",
    inQueue: "排队中",
    dashboardSubtitle: "系统概览与自动化任务",
    successVsFailure: "每日成功/失败统计",
    clickToFilter: "点击筛选",
    clickToReset: "点击重置",
    failedToUpdate: "更新任务失败",
    filterEmptyNeedsAttention: "所有任务运行正常，暂无需处理的任务。",
    filterEmptyRunning: "当前没有正在运行的任务。",
    filterEmptySuccess: "最近没有成功完成的任务。",
    filterEmptyFailed: "最近没有失败的任务。",
    showAllTasks: "显示所有任务",
    reset: "重置",
    showing: "正在显示",
    blockedTasks: "被阻塞",

    run: "运行",
    retry: "重试",
    cancel: "取消",
    enable: "启用",
    disable: "禁用",
    taskTriggered: "任务已触发",
    taskTriggeredDesc: "自动化任务已加入队列。",
    failedToTrigger: "触发任务失败",
    taskEnabled: "任务已启用",
    taskEnabledDesc: "任务将按计划运行。",
    taskDisabled: "任务已禁用",
    taskDisabledDesc: "任务已暂停，不会触发。",
    cloneTask: "克隆任务",
    taskCloned: "任务已克隆",
    taskClonedDesc: "副本已创建（默认未启用），请检查后再开启。",
    failedToClone: "克隆失败",
    backup: "备份",
    exportTasks: "导出全部任务",
    exportTemplates: "导出为模板（不含具体值）",
    importTasks: "导入任务…",
    tasksImported: "导入完成",
    failedToImport: "导入失败",
    searchTasks: "搜索任务或网址…",
    cancelRequested: "取消请求已发送",
    cancelRequestedDesc: "任务即将停止。",
    neverRun: "从未运行",
    loading: "加载中…",
    noTasks: "暂无任务，点击「新建任务」开始",
    nextIn: "距下次",
    statusSuccess: "成功",
    statusFailed: "失败",
    statusRunning: "运行中",
    statusQueued: "排队中",
    statusNeedsAttention: "需处理",
    newTask: "新建任务",
    editTask: "编辑任务",
    taskName: "任务名称",
    taskNamePlaceholder: "输入任务名称",
    targetUrl: "目标 URL",
    targetUrlPlaceholder: "https://example.com",
    schedule: "调度计划",
    noSchedule: "不自动调度",
    cronExpression: "Cron 表达式",
    randomSchedule: "随机调度",
    afterCompletion: "完成后再次运行",
    browserConfig: "浏览器配置",
    enableBrowserConfig: "启用自定义浏览器配置",
    provider: "驱动",
    wsEndpoint: "WebSocket 地址",
    proxy: "代理地址",
    stealthMode: "隐身模式",
    blockAds: "屏蔽广告",
    ignoreHTTPS: "忽略 HTTPS 错误",
    sessionTimeout: "会话超时（毫秒）",
    workflowSteps: "工作流步骤",
    addStep: "添加步骤",
    saveTask: "保存任务",
    saving: "保存中…",
    taskCreated: "任务已创建",
    taskUpdated: "任务已更新",
    failedToSave: "保存失败",
    failedToLoad: "加载失败",
    stepsImported: "已导入步骤",
    randomWindow: "时间窗口",
    timesPerCycle: "每个周期内执行次数",
    afterCompletionDesc: "分钟后",
    editTask2: "编辑",
    deleteTask: "删除任务",
    confirmDelete: "确认删除",
    confirmDeleteDesc: "此操作不可撤销，任务及其所有历史日志将被永久删除。",
    confirmDeleteBtn: "确认删除",
    taskNotFound: "任务未找到",
    taskDeleted: "任务已删除",
    failedToDelete: "删除失败",
    enabled: "已启用",
    disabled: "已禁用",
    lastRun: "上次运行",
    nextRun: "下次运行",
    runHistory: "运行历史",
    noLogs: "暂无运行记录",
    viewLog: "查看日志",
    taskConfig: "任务配置",
    browserProvider: "浏览器驱动",
    runTaskNow: "立即运行",
    taskCancelled: "任务已取消",
    failedToCancel: "取消失败",
    updatedAgo: "刷新于",
    runningStream: "实时日志",
    backToTask: "返回任务",
    executionLog: "执行日志",
    startedAt: "开始时间",
    duration: "耗时",
    steps: "步骤",
    noLogData: "暂无日志数据",
    allTasks: "所有任务",
    filterByTask: "按任务筛选",
    filterByStatus: "按状态筛选",
    allStatuses: "所有状态",
    noLogsFound: "未找到日志",
    task: "任务",
    date: "时间",
    status: "状态",
    addCredential: "添加凭证",
    editCredential: "编辑凭证",
    credentialName: "凭证名称",
    username: "用户名",
    password: "密码",
    totp: "TOTP 密钥（可选）",
    totpPlaceholder: "Base32 密钥",
    saveCredential: "保存凭证",
    deleteCredential: "删除凭证",
    confirmDeleteCred: "确认删除凭证",
    confirmDeleteCredDesc: "此操作不可撤销，凭证将被永久删除。",
    credentialSaved: "凭证已保存",
    credentialUpdated: "凭证已更新",
    credentialDeleted: "凭证已删除",
    failedToSaveCred: "保存凭证失败",
    failedToDeleteCred: "删除凭证失败",
    noCredentials: "暂无凭证，点击「添加凭证」开始",
    retentionSettings: "日志与截图保留策略",
    logRetentionDays: "日志保留天数",
    logRetentionDesc: "超过此天数的日志将在每天 03:30 自动删除。设为 0 表示永久保留。",
    maxScreenshotStorage: "截图最大存储空间（MB）",
    maxScreenshotDesc: "磁盘用量超过此值时，最旧的截图将被自动删除。设为 0 表示不限制。",
    runCleanupNow: "立即清理",
    retentionSaved: "保留策略已保存",
    cleanupComplete: "清理完成",
    cleanupCompleteDesc: "旧日志和截图已清除。",
    cleanupFailed: "清理失败",
    saveFailed: "保存失败",
    networkError: "网络错误",
    pollingInterval: "数据刷新间隔",
    pollingIntervalDesc: "控制页面自动刷新的频率（对当前设备生效）。",
    changePassword: "修改密码",
    currentPassword: "当前密码",
    newPassword: "新密码",
    repeatPassword: "确认新密码",
    passwordChanged: "密码已修改",
    passwordChangeFailed: "密码修改失败",
    wrongPassword: "当前密码错误",
    passwordMismatch: "两次输入的密码不一致",
    taskTimeout: "任务超时设置",
    taskTimeoutDesc: "任务运行超过此时长后将被自动终止。",
    timeoutDisabled: "不限制",
    timeoutCustom: "自定义",
    timeoutMinutes: "分钟",
    captchaSettings: "验证码破解设置",
    captchaProvider: "验证码服务商",
    noCaptcha: "不使用",
    captchaSaved: "验证码设置已保存",
    aboutSystem: "系统信息",
    version: "版本",
    uptime: "运行时长",
    database: "数据库",
    dbConnected: "已连接",
    dbError: "连接失败",
    systemInfoFailed: "无法加载系统信息",
    browserSettings: "浏览器连接设置",
    testConnection: "测试连接",
    connectionOk: "连接成功",
    connectionFailed: "连接失败",
    browserSettingsSaved: "浏览器设置已保存",
    allSystemsOk: "所有服务运行正常",
    systemsDegraded: "部分服务异常",
    taskScheduler: "任务调度器",
    browserService: "浏览器服务",
    signIn: "登录",
    enterPassword: "输入密码",
    invalidPassword: "密码错误",
    setupTitle: "初始化设置",
    setupDesc: "设置管理员密码以完成初始化",
    repeatPasswordPlaceholder: "再次输入密码",
    setPassword: "设置密码",
    settingUp: "初始化中…",
    stepRecorderTitle: "操作录制",
    startSession: "启动浏览器",
    stopSession: "停止会话",
    takeScreenshot: "截图",
    copySteps: "复制步骤",
    loadToForm: "导入到任务",
    clearSteps: "清空步骤",
    enterUrl: "输入目标 URL",
    startingBrowser: "正在启动浏览器…",
    sessionActive: "会话运行中",
    noStepsYet: "暂无录制步骤",
    stepsCopied: "步骤已复制到剪贴板",
    stepsLoaded: "步骤已导入任务表单",
    screenshotTaken: "截图已保存",
    failedToStart: "启动浏览器会话失败",
    pageNotFound: "404 页面不存在",
    pageNotFoundHint: "该页面不存在或已被移除。",
  
      returnToDashboard: "返回控制台",
      stopThisTask: "停止此任务？",
      keepRunning: "继续运行",
      areYouSure: "确认操作？",
      captchaDetected: "检测到验证码 — 需要手动处理",
      loginStrategy: "登录策略",
      manualOnly: "仅手动",
      lastExecution: "上次执行",
      stopRequested: "停止请求已发送",
      stopRequestedDesc: "任务将在当前步骤完成后停止。",
      couldNotStop: "无法停止",
      failedToReachServer: "无法连接到服务器",
      alreadyRunning: "已在运行中",
      alreadyRunningDesc: "此任务已在进行中。",
      retryMission: "重试任务",
      postcheckScreenshot: "事后截图",
      maxConcurrentSessions: "最大并发会话数",
      advancedOptions: "高级选项",
      testUrl: "测试 URL",
      platformConfig: "平台配置与偏好设置",
      intervalFastest: "1秒 — 最快，服务器负载较高",
      intervalBalanced: "2秒 — 均衡（默认）",
      intervalSlower: "5秒 — 较慢，减少网络使用",
      platform: "平台",
      startRecording: "开始录制",
      startingUrl: "起始 URL",
      howItWorks: "使用方法",
      copiedLabel: "已复制！",
      copyJson: "复制 JSON",
      quickLabel: "快捷：",
      logNotFound: "日志未找到",
      timestamp: "时间",
      result: "结果",
      executionScreenshot: "执行截图",
      stepScreenshot: "步骤截图",
      copy: "复制",
      noStepLogs: "本次运行没有步骤日志（失败发生在步骤开始之前）。",
      finalScreenshot: "最终截图",
      dryRun: "预演",
      executionAborted: "执行已中止",
      completedWithoutErrors: "无错误完成",
      schedulerError: "无法连接到调度器",
      apiServerError: "无法连接到 API 服务器",
      dbQueryFailed: "数据库查询失败",
      stepLogin: "登录",
      stepLoginDesc: "通过表单、GitHub 或 Google OAuth 认证",
      stepNavigate: "导航",
      stepNavigateDesc: "跳转到 URL",
      stepClick: "点击",
      stepClickDesc: "点击元素",
      stepFill: "填写输入",
      stepFillDesc: "在输入框中输入文字",
      stepSelectOpt: "选择选项",
      stepSelectOptDesc: "从下拉框选择",
      stepScroll: "滚动",
      stepScrollDesc: "滚动页面或元素到视图",
      stepHover: "悬停",
      stepHoverDesc: "鼠标悬停到元素上",
      stepWait: "等待",
      stepWaitDesc: "暂停 N 毫秒",
      stepWaitFor: "等待出现",
      stepWaitForDesc: "等待元素或文字出现",
      stepScreenshotType: "截图",
      stepScreenshotTypeDesc: "截取当前页面",
      stepSwitchTab: "切换新标签页",
      stepSwitchTabDesc: "切换焦点到新打开的标签页",
      stepKeyPress: "按键",
      stepKeyPressDesc: "发送键盘快捷键或按键",
      stepCondition: "条件",
      stepConditionDesc: "条件成立时执行操作",
      stepDismissPopups: "关闭弹窗/遮罩",
      stepDismissPopupsDesc: "清理 cookie 弹窗、遮罩层和广告浮层",
      stepCfVerify: "机器人验证",
      stepCfVerifyDesc: "自动处理 Cloudflare Turnstile、reCAPTCHA、hCaptcha 等多种人机验证",
      stepCfVerifyUrl: "目标网址",
      stepCfVerifyReloads: "最大重载次数",
      stepCfVerifyHint: "在点击/填写目标只有通过 Cloudflare 验证后才可交互时使用。留空网址则对当前页面执行；验证仍未通过时会刷新页面并重试。",
      loginMethod: "登录方式",
      standardForm: "标准表单",
      loginPageUrl: "登录页 URL",
      useSavedCredential: "使用已保存凭证",
      enterInline: "手动输入",
      selectCredential: "选择已保存的凭证…",
      noSavedCredentials: "暂无已保存凭证，请手动输入或前往",
      successSelector: "成功选择器",
      successText: "成功文本",
      ifCondition: "条件类型",
      textContains: "页面包含文字",
      textNotContains: "页面不包含文字",
      elementVisible: "元素可见",
      elementNotVisible: "元素不可见",
      urlContains: "URL 包含",
      conditionValue: "匹配值",
      conditionSelector: "元素选择器（可选）",
      thenExecute: "满足条件时执行",
      moveUp: "上移",
      moveDown: "下移",
      dragToReorder: "拖拽调整顺序",
      removeStep: "删除步骤",
      importJson: "导入 JSON",
      clearAll: "清空全部",
      noStepsAdded: "尚未添加步骤",
      inUseByTasks: "{n} 个任务在用",
      notInUse: "未被任务使用",
      deleteInUseWarning: "以下任务正在使用它，删除后这些任务会回落到默认设置：",
      andNMore: "等 {n} 个",
      providersIntro:
        "具名浏览器后端。建好后在任务里下拉选择用哪个跑。每个后端有自己的并发上限，各管各的。任务选「默认」时用这里标记为默认的那个。",
      addProvider: "添加后端",
      editProvider: "编辑后端",
      noProvidersYet: "还没有后端，先添加一个。",
      checkAll: "检测全部",
      checkOne: "检测",
      healthCheckFailed: "检测失败",
      concurrencyLimit: "并发上限",
      concurrencyShort: "并发",
      liveRunningQueued: "运行中 {r} · 排队 {q}",
      setAsDefault: "设为默认",
      defaultBadge: "默认",
      defaultProviderHint: "任务里选「默认」时使用这个后端",
      urlHintCdp: "CDP WebSocket 端点（ws:// 或 wss://）",
      urlHintSidecar: "sidecar HTTP 地址（http:// 或 https://），健康检查 GET /health",
      blockAdsLabel: "屏蔽广告",
      ignoreHttpsErrors: "忽略 HTTPS 错误",
      blockWebrtcLabel: "屏蔽 WebRTC",
      blockWebrtcHint: "建议开启；关掉会让 WebRTC 泄露一个可能与代理不一致的 IP",
      humanizeLabel: "Humanize（拟人光标）",
      humanizeHint: "更像真人但更慢（Camoufox 原生默认关闭）",
      sessionTimeoutMinutes: "会话超时（分钟）",
      defaultResolution: "默认分辨率",
      resolutionHint: "分辨率只是默认值；选了指纹档案时以指纹自带的屏幕为准。",
      enabledLabel: "启用",
      disabledSuffix: "已停用",
      deleteProviderTitle: "删除这个后端？",
      deleteProviderDesc: "使用它的任务会回落到默认后端。",
      providerSaved: "后端已保存",
      providerUpdated: "后端已更新",
      providerDeleted: "后端已删除",
      tasksFellBackToDefault: "{n} 个任务已回落到默认后端",
      nameAndUrlRequired: "名称和 URL 不能为空",
      fieldName: "名称",
      fieldType: "类型",
      actionSave: "保存",
      actionAdd: "添加",
      actionDelete: "删除",
      proxiesTitle: "代理",
      proxiesIntro: "可复用的出口代理。添加一次，之后在任务里下拉选择。WARP 是按任务配置的，不在这里。",
      addProxy: "添加代理",
      editProxy: "编辑代理",
      noProxiesYet: "还没有代理。",
      proxyUrlLabel: "代理地址",
      proxyUrlHint: "必须带协议前缀：http/https/socks5/vless/vmess/trojan/…",
      refreshExitAll: "刷新全部",
      refreshExitOne: "刷新出口信息",
      exitNotChecked: "未检测",
      exitCheckFailed: "检测失败",
      exitCheckingInBackground: "出口 IP 正在后台检测，稍后刷新或点单条的刷新按钮查看",
      allProxiesRefreshed: "全部代理已刷新",
      failedToRefresh: "刷新失败",
      proxySaved: "代理已保存",
      proxyUpdated: "代理已更新",
      proxyDeleted: "代理已删除",
      deleteProxyTitle: "删除这个代理？",
      deleteProxyDesc: "使用它的任务会回落到不使用代理。",
      tasksFellBackToNoProxy: "{n} 个任务已回落到无代理",
      nameAndProxyUrlRequired: "名称和代理地址不能为空",
      fingerprintsTitle: "浏览器指纹",
      fingerprintsIntro:
        "可复用的设备指纹。给任务绑一个，它每次运行就都是同一台「设备」——真人本来就只有一台。在任务里下拉选择。",
      addFingerprint: "添加指纹",
      editFingerprint: "编辑指纹",
      noFingerprintsYet: "还没有指纹档案。",
      operatingSystem: "操作系统",
      generateFingerprint: "生成指纹",
      generatedFixedOnSave: "已生成 · 保存后固定",
      sourceBrowserforge: "browserforge 合成",
      sourceRealPreset: "真机预设",
      generateHint: "点「生成指纹」产出一套真实且内部一致的指纹（Camoufox 引擎级伪装），保存后固定不变。",
      fingerprintGenerated: "指纹已生成 —— 保存后固定",
      generateFailed: "生成失败",
      screenFixedByFingerprint: "由生成的指纹决定",
      optionalSuffix: "可选",
      autoFromProxyIp: "留空 = 跟随代理出口 IP",
      fingerprintSaved: "指纹已保存",
      fingerprintUpdated: "指纹已更新",
      fingerprintDeleted: "指纹已删除",
      deleteFingerprintTitle: "删除这个指纹？",
      deleteFingerprintDesc: "使用它的任务会回落到默认指纹。",
      tasksFellBackToDefaultFp: "{n} 个任务已回落到默认指纹",
      nameRequired: "名称不能为空",
      gpuLabel: "显卡",
      screenLabel: "屏幕",
      platformLabel: "平台",
      cpuCoresLabel: "CPU 核心",
      runDurationSuffix: "耗时",
      last24hOnly: "仅显示 24 小时内",
      newGroup: "新建分组",
      groupName: "分组名称",
      renameGroup: "重命名分组",
      deleteGroupTitle: "删除这个分组？",
      deleteGroupDesc: "分组里的任务不会被删除，只会变成未分组。",
      ungrouped: "未分组",
      dragToReorderTasks: "拖拽调整顺序，拖到分组标题上可移入该分组",
      dragDisabledWhileFiltering: "筛选或搜索时无法拖拽排序",
      groupCreated: "分组已创建",
      groupUpdated: "分组已更新",
      groupDeleted: "分组已删除",
      tasksUngrouped: "{n} 个任务已变为未分组",
      orderSaved: "顺序已保存",
      failedToReorder: "保存顺序失败",
      resultsCount: "{n} 条结果",
      enterValidUrl: "请输入有效的 URL",
      tasksImportedDetail: "{n} 个任务已导入（已停用，请检查后再启用）",
      tasksSkipped: "；{n} 个跳过",
      fingerprintTip: "指纹：{name}",
      fingerprintTipNone: "指纹：未绑定档案（{os}）",
      screenshotExpired: "截图已过期",
      credentialsIntro: "AES-256-GCM 加密存储，可跨任务复用",
      hideValue: "隐藏",
      showValue: "显示",
      leaveEmptyToKeep: "（留空保持不变）",
      leaveEmptyKeepTotp: "留空保持现有 2FA",
      totpAutofillHint: "用于 GitHub / Google 双因素认证自动填写",
      timeoutSaved: "任务超时已保存",
      captchaNoneHint: "无验证码破解服务。遇到验证码时任务将暂停，需人工处理。",
      maxQueueDepthLabel: "最大队列深度",
      concurrencyControl: "并发控制",
      backendMovedToProviders: "浏览器后端已统一到 Providers 页管理：在那里新增/编辑后端（引擎、地址、Stealth、屏蔽广告、忽略 HTTPS、会话超时、分辨率、并发上限），并用 ★ 指定默认后端。任务里选「默认」就跟随它。",
      goToProvidersPage: "去 Providers 页配置",
      noneValue: "无",
      defaultProviderIs: "默认（{name} · {type}）",
      defaultProviderUnset: "默认（未设置默认 provider）",
      autoFollowExitIp: "auto（跟随出口 IP）",
      continueNextStep: "继续下一步",
      exitTaskSuccess: "结束 · 成功",
      exitTaskFailure: "结束 · 失败",
      cookieOnlyMethod: "仅 Cookie",
      requiredOneOfTwo: "二选一必填",
      requiredSuffix: "必填",
      optionalSeedSuffix: "可选，首次种子",
      successTextPlaceholder: "Welcome, Dashboard, 登录成功",
      successTextHint: "登录完成后检测页面是否包含该文字，找到则登录成功，找不到则失败。",
      cookieOnlyNeedsCriteria: "仅 Cookie 模式必须填上面两项之一：没有判据就无法确认 cookie 是否有效，运行时会一律报「cookie 无效」。",
      cookieOnlyExplain: "仅 Cookie：不做自动登录。用粘贴的 cookie 打开页面，命中「登录成功判据」就算通过；判据没命中就直接失败（提示你重新粘贴），不会用错误的登录态往下跑。成功一次后会自动保存真实 cookie 并接管。",
      cookieModeLabel: "Cookie 模式（会话保持）",
      cookieModeHint: "启用后，登录成功的会话（cookies + localStorage）会被加密保存。下次运行先检测会话是否有效：有效则跳过登录，失效则重新登录并刷新保存。",
      sessionKeyHint: "同一任务可用不同 key 保存多个身份，留空使用 \"default\"。",
      cookiePasteHint: "只需填登录票据那一条，不用把所有 cookie 都复制。名字各站不同（Pterodactyl/Laravel 面板是 remember_web_*，GitHub 是 _github_session）：F12 → Application → Cookies 里找，多条用 ; 分隔。仅在还没存过会话时用作种子；成功跑一次后会自动保存真实 cookie 并接管。",
      whenConditionTrue: "条件成立",
      elseWhenFalse: "Else — 条件不成立时",
      timeoutMsLabel: "超时时间 (ms)",
      dismissPopupsHint: "关闭 cookie 弹窗、遮罩层和广告浮层，避免它们遮挡后续操作。无需任何参数。",
      queueWaitTimeout: "队列等待超时",
      taskNameRequired: "任务名称不能为空",
      targetUrlRequired: "目标 URL 不能为空",
      cookieOnlyNoCriterionTitle: "仅 Cookie 登录缺少判据",
      cookieOnlyNoCriterionDesc: "步骤 {n}：请填写「登录成功文字」或「登录成功选择器」，否则无法判断 cookie 是否有效。",
      unitDays: "天",
      unitHours: "小时",
      unitMinutes: "分钟",
      unitTimes: "次",
      unitEvery: "每",
      randomWindowLabel: "时间窗口（在此周期内随机执行）",
      runsPerWindowLabel: "每个周期内执行次数",
      randomScheduleHint: "每次运行后开始计算下一个窗口，在窗口内随机安排 {n} 次运行。例如设为 3 天 1 次：上次运行完成后，下次运行会在 3 天内的某个随机时刻执行。",
      retryOnFailure: "失败自动重试",
      retryAfterFailure: "失败后重试",
      retryTimesEvery: "次，每次间隔",
      retryHint: "留空或 0 = 不重试（失败后等下一次定时触发）。重试次数按连续失败计算，成功一次就清零；用完仍失败则回到正常调度。手动取消的运行不会重试。",
      webhookTrigger: "Webhook 触发",
      webhookIntro: "开启后，第三方监控（Uptime Kuma 等）检测到服务挂掉时可以直接调用这个地址触发本任务。",
      autoGeneratedPlaceholder: "（自动生成）",
      regenerate: "重新生成",
      webhookUseThisEdit: "在监控里这样配（保存后生效）：",
      webhookUseThisNew: "保存任务后，用下面的方式调用：",
      taskIdPlaceholder: "<任务ID>",
      webhookAuthHint: "token 不对、webhook 未开启、或任务不存在，都统一返回 401（避免被拿去探测任务是否存在）。任务被停用返回 409。这个接口不需要登录，只认这个 token —— 请当密码保管。",
      browserBackendSection: "浏览器后端",
      defaultShort: "默认",
      backendSectionHint: "选一个「Providers」页里配好的后端，并为此任务单独指定代理 / 指纹，不影响其他任务",
      providerOptionLine: "{name}（{type}，并发 {n}）",
      providerFieldHint: "引擎、地址、Stealth、分辨率等都在「Providers」页配置，并使用该 provider 自己的并发上限。「默认」跟随 Providers 页里标为默认的那个。",
      noDefaultProviderYet: "目前还没有默认 provider，去 Providers 页设一个。",
      proxyLabel: "代理",
      proxyNone: "不使用",
      proxyWarpRotate: "WARP 自动轮换",
      proxyCustom: "自定义",
      proxySelectHint: "选「代理」页里保存的出口，或 WARP 自动轮换，或自定义手填地址。",
      proxyUrlPlaceholder: "socks5://user:pass@host:1080 或 http/vless/vmess/trojan/hy2/tuic/ss://…",
      proxyCustomHint: "直接填代理 URL，协议由前缀识别（http/socks5 原生支持；vless/vmess/trojan/hy2/tuic/ss 会本地起 sing-box 转 SOCKS5）。",
      warpRotationsLabel: "换 IP 重试次数",
      warpRotationsPlaceholder: "留空 = 用默认值（RECAPTCHA_MAX_IP_ROTATIONS，默认 5）",
      warpRotationsHint: "reCAPTCHA 语音验证被拒（\"automated queries\"）时，注册新的 WARP 身份换一个出口 IP 再试，最多这么多次。换 IP 时 sing-box 在同一本地端口重启，浏览器和页面状态不受影响；每次重试也会从新 IP 重新点一次 checkbox（有机会直接通过）。填 0 关闭。",
      fingerprintFieldLabel: "浏览器指纹",
      fingerprintNoneReal: "不使用（真实指纹）",
      fingerprintHintCamoufox: "只能选「浏览器指纹」页里保存的档案（引擎级伪装，含时区/语言）。要新的就去那一页生成一个。",
      fingerprintHintSb: "SeleniumBase 只能伪装 系统/时区/语言，用不了生成的固定指纹（browserforge / 真机预设），这类档案已从列表中隐藏。",
  };

  export const en: Translations = {
    dashboard: "Dashboard",
    logsExplorer: "Logs Explorer",
    stepRecorder: "Step Recorder",
    credentials: "Credentials",
    systemStatus: "System Status",
    settings: "Settings",
    signOut: "Sign out",
    controlPanel: "Control Panel",
    systemOnline: "System Online",
    browser: "Browser",
    paused: "PAUSED",
    live: "LIVE",
    idle: "IDLE",
    newMission: "New Mission",
    activeConfigurations: "Active Configurations",
    runningNow: "Running Now",
    successLast24h: "Success (24h)",
    failedLast24h: "Failed (24h)",
    needsAttention: "Needs Attention",
    totalJobs: "Total Jobs",
    sevenDayHistory: "7-Day Run History",
    inQueue: "In Queue",
    dashboardSubtitle: "System overview and automation jobs",
    successVsFailure: "success vs failure per day",
    clickToFilter: "click to filter",
    clickToReset: "click to reset",
    failedToUpdate: "Failed to update task",
    filterEmptyNeedsAttention: "All tasks are running smoothly — nothing needs your attention right now.",
    filterEmptyRunning: "No tasks are currently running.",
    filterEmptySuccess: "No tasks have succeeded recently.",
    filterEmptyFailed: "No tasks have failed recently.",
    showAllTasks: "Show all tasks",
    reset: "Reset",
    showing: "Showing",
    blockedTasks: "blocked",
    run: "Run",
    retry: "Retry",
    cancel: "Cancel",
    enable: "Enable",
    disable: "Disable",
    taskTriggered: "Task triggered",
    taskTriggeredDesc: "The automation job has been queued.",
    failedToTrigger: "Failed to trigger task",
    taskEnabled: "Task enabled",
    taskEnabledDesc: "The task will run on schedule.",
    taskDisabled: "Task disabled",
    taskDisabledDesc: "The task has been paused.",
    cloneTask: "Clone task",
    taskCloned: "Task cloned",
    taskClonedDesc: "The copy was created disabled — review it before enabling.",
    failedToClone: "Clone failed",
    backup: "Backup",
    exportTasks: "Export all tasks",
    exportTemplates: "Export as templates (no values)",
    importTasks: "Import tasks…",
    tasksImported: "Import complete",
    failedToImport: "Import failed",
    searchTasks: "Search tasks or URL…",
    cancelRequested: "Cancel requested",
    cancelRequestedDesc: "The task will stop shortly.",
    neverRun: "never run",
    loading: "Loading…",
    noTasks: "No tasks yet — click New Mission to get started",
    nextIn: "in",
    statusSuccess: "SUCCESS",
    statusFailed: "FAILED",
    statusRunning: "RUNNING",
    statusQueued: "QUEUED",
    statusNeedsAttention: "NEEDS ATTENTION",
    newTask: "New Task",
    editTask: "Edit Task",
    taskName: "Task Name",
    taskNamePlaceholder: "Enter task name",
    targetUrl: "Target URL",
    targetUrlPlaceholder: "https://example.com",
    schedule: "Schedule",
    noSchedule: "No schedule",
    cronExpression: "Cron expression",
    randomSchedule: "Random schedule",
    afterCompletion: "Run again after completion",
    browserConfig: "Browser Config",
    enableBrowserConfig: "Enable custom browser config",
    provider: "Provider",
    wsEndpoint: "WebSocket endpoint",
    proxy: "Proxy URL",
    stealthMode: "Stealth mode",
    blockAds: "Block ads",
    ignoreHTTPS: "Ignore HTTPS errors",
    sessionTimeout: "Session timeout (ms)",
    workflowSteps: "Workflow Steps",
    addStep: "Add Step",
    saveTask: "Save Task",
    saving: "Saving…",
    taskCreated: "Task created",
    taskUpdated: "Task updated",
    failedToSave: "Failed to save",
    failedToLoad: "Failed to load",
    stepsImported: "steps imported",
    randomWindow: "Time window",
    timesPerCycle: "Times per cycle",
    afterCompletionDesc: "minutes after completion",
    editTask2: "Edit",
    deleteTask: "Delete Task",
    confirmDelete: "Confirm Delete",
    confirmDeleteDesc: "This action cannot be undone. The task and all its logs will be permanently deleted.",
    confirmDeleteBtn: "Delete",
    taskNotFound: "Task not found",
    taskDeleted: "Task deleted",
    failedToDelete: "Failed to delete",
    enabled: "Enabled",
    disabled: "Disabled",
    lastRun: "Last run",
    nextRun: "Next run",
    runHistory: "Run History",
    noLogs: "No run history yet",
    viewLog: "View log",
    taskConfig: "Task Config",
    browserProvider: "Browser provider",
    runTaskNow: "Run now",
    taskCancelled: "Task cancelled",
    failedToCancel: "Failed to cancel",
    updatedAgo: "Updated",
    runningStream: "Live log",
    backToTask: "Back to task",
    executionLog: "Execution Log",
    startedAt: "Started at",
    duration: "Duration",
    steps: "Steps",
    noLogData: "No log data",
    allTasks: "All tasks",
    filterByTask: "Filter by task",
    filterByStatus: "Filter by status",
    allStatuses: "All statuses",
    noLogsFound: "No logs found",
    task: "Task",
    date: "Date",
    status: "Status",
    addCredential: "Add Credential",
    editCredential: "Edit Credential",
    credentialName: "Name",
    username: "Username",
    password: "Password",
    totp: "TOTP secret (optional)",
    totpPlaceholder: "Base32 secret",
    saveCredential: "Save",
    deleteCredential: "Delete",
    confirmDeleteCred: "Delete credential",
    confirmDeleteCredDesc: "This action cannot be undone.",
    credentialSaved: "Credential saved",
    credentialUpdated: "Credential updated",
    credentialDeleted: "Credential deleted",
    failedToSaveCred: "Failed to save credential",
    failedToDeleteCred: "Failed to delete credential",
    noCredentials: "No credentials yet — click Add Credential to get started",
    retentionSettings: "Log & Screenshot Retention",
    logRetentionDays: "Log retention (days)",
    logRetentionDesc: "Logs older than this are deleted each night at 03:30. Set 0 to keep forever.",
    maxScreenshotStorage: "Max screenshot storage (MB)",
    maxScreenshotDesc: "Oldest screenshots are removed when disk usage exceeds this. Set 0 for no limit.",
    runCleanupNow: "Run cleanup now",
    retentionSaved: "Retention settings saved",
    cleanupComplete: "Cleanup complete",
    cleanupCompleteDesc: "Old logs and screenshots have been removed.",
    cleanupFailed: "Cleanup failed",
    saveFailed: "Save failed",
    networkError: "Network error",
    pollingInterval: "Polling interval",
    pollingIntervalDesc: "Controls how often the page auto-refreshes data (applies to this device only).",
    changePassword: "Change Password",
    currentPassword: "Current password",
    newPassword: "New password",
    repeatPassword: "Repeat new password",
    passwordChanged: "Password changed",
    passwordChangeFailed: "Failed to change password",
    wrongPassword: "Current password is incorrect",
    passwordMismatch: "Passwords do not match",
    taskTimeout: "Task Timeout",
    taskTimeoutDesc: "Tasks running longer than this will be automatically terminated.",
    timeoutDisabled: "Disabled",
    timeoutCustom: "Custom",
    timeoutMinutes: "minutes",
    captchaSettings: "Captcha Settings",
    captchaProvider: "Provider",
    noCaptcha: "None",
    captchaSaved: "Captcha settings saved",
    aboutSystem: "About",
    version: "Version",
    uptime: "Uptime",
    database: "Database",
    dbConnected: "connected",
    dbError: "error",
    systemInfoFailed: "Unable to load system information.",
    browserSettings: "Browser Connection",
    testConnection: "Test connection",
    connectionOk: "Connection successful",
    connectionFailed: "Connection failed",
    browserSettingsSaved: "Browser settings saved",
    allSystemsOk: "All systems operational",
    systemsDegraded: "One or more services are degraded",
    taskScheduler: "Task Scheduler",
    browserService: "Browser Service",
    signIn: "Sign in",
    enterPassword: "Enter password",
    invalidPassword: "Invalid password",
    setupTitle: "Initial Setup",
    setupDesc: "Set an admin password to get started",
    repeatPasswordPlaceholder: "Repeat password",
    setPassword: "Set Password",
    settingUp: "Setting up…",
    stepRecorderTitle: "Step Recorder",
    startSession: "Start browser",
    stopSession: "Stop session",
    takeScreenshot: "Screenshot",
    copySteps: "Copy steps",
    loadToForm: "Load to task form",
    clearSteps: "Clear steps",
    enterUrl: "Enter target URL",
    startingBrowser: "Starting browser…",
    sessionActive: "Session active",
    noStepsYet: "No steps recorded yet",
    stepsCopied: "Steps copied to clipboard",
    stepsLoaded: "Steps loaded into task form",
    screenshotTaken: "Screenshot saved",
    failedToStart: "Failed to start browser session",
    pageNotFound: "404 Page Not Found",
    pageNotFoundHint: "Did you forget to add the page to the router?",
  
      returnToDashboard: "Return to Dashboard",
      stopThisTask: "Stop this task?",
      keepRunning: "Keep running",
      areYouSure: "Are you absolutely sure?",
      captchaDetected: "Captcha Detected — Manual Action Required",
      loginStrategy: "Login Strategy",
      manualOnly: "Manual only",
      lastExecution: "Last Execution",
      stopRequested: "Stop requested",
      stopRequestedDesc: "The task will stop after the current step completes.",
      couldNotStop: "Could not stop",
      failedToReachServer: "Failed to reach server",
      alreadyRunning: "Already running",
      alreadyRunningDesc: "This task is already in progress.",
      retryMission: "Retry Mission",
      postcheckScreenshot: "Postcheck screenshot",
      advancedOptions: "Advanced Options",
      testUrl: "Test URL",
      platformConfig: "Platform configuration and preferences",
      intervalFastest: "1 second — fastest, higher server load",
      intervalBalanced: "2 seconds — balanced (default)",
      intervalSlower: "5 seconds — slower, reduced network usage",
      platform: "Platform",
      startRecording: "Start Recording",
      startingUrl: "Starting URL",
      howItWorks: "How it works",
      copiedLabel: "Copied!",
      copyJson: "Copy JSON",
      quickLabel: "Quick:",
      logNotFound: "Log not found",
      timestamp: "Timestamp",
      result: "Result",
      executionScreenshot: "Execution Screenshot",
      stepScreenshot: "Step Screenshot",
      copy: "Copy",
      noStepLogs: "No step logs for this run (it failed before any step started).",
      finalScreenshot: "Final Screenshot",
      dryRun: "Dry Run",
      executionAborted: "Execution aborted",
      completedWithoutErrors: "Completed without errors",
      schedulerError: "Could not reach the scheduler",
      apiServerError: "Could not reach the API server",
      dbQueryFailed: "Database query failed",
      stepLogin: "Login",
      stepLoginDesc: "Authenticate via form, GitHub, or Google OAuth",
      stepNavigate: "Navigate",
      stepNavigateDesc: "Go to a URL",
      stepClick: "Click",
      stepClickDesc: "Click an element",
      stepFill: "Fill Input",
      stepFillDesc: "Type into a field",
      stepSelectOpt: "Select Option",
      stepSelectOptDesc: "Choose from a dropdown",
      stepScroll: "Scroll",
      stepScrollDesc: "Scroll page or element into view",
      stepHover: "Hover",
      stepHoverDesc: "Mouse over an element",
      stepWait: "Wait",
      stepWaitDesc: "Pause for N milliseconds",
      stepWaitFor: "Wait For",
      stepWaitForDesc: "Wait until element or text appears",
      stepScreenshotType: "Screenshot",
      stepScreenshotTypeDesc: "Capture current page",
      stepSwitchTab: "Switch to New Tab",
      stepSwitchTabDesc: "Switch focus to the newly opened tab",
      stepKeyPress: "Key Press",
      stepKeyPressDesc: "Send a keyboard shortcut or key",
      stepCondition: "Condition",
      stepConditionDesc: "If condition is met, execute an action",
      stepDismissPopups: "Dismiss Popups",
      stepDismissPopupsDesc: "Clear cookie banners, overlays and ad popups",
      stepCfVerify: "Bot Verify",
      stepCfVerifyDesc: "Auto-solve Cloudflare Turnstile, reCAPTCHA, hCaptcha and other bot checks",
      stepCfVerifyUrl: "Target URL",
      stepCfVerifyReloads: "Max reloads",
      stepCfVerifyHint: "Use before a click/fill whose target only becomes interactive once a Cloudflare / Turnstile challenge is passed. Leave URL blank to run on the current page; if the challenge is not cleared, the page is reloaded and retried.",
      loginMethod: "Login Method",
      standardForm: "Standard Form",
      loginPageUrl: "Login Page URL",
      useSavedCredential: "Use saved credential",
      enterInline: "Enter inline",
      selectCredential: "Select a saved credential…",
      noSavedCredentials: "No saved credentials yet. Enter inline or add one in",
      successSelector: "Success Selector",
      successText: "Success Text",
      ifCondition: "If condition",
      textContains: "Page contains text",
      textNotContains: "Page does NOT contain text",
      elementVisible: "Element is visible",
      elementNotVisible: "Element is NOT visible",
      urlContains: "URL contains",
      conditionValue: "Match value",
      conditionSelector: "Element selector (optional)",
      thenExecute: "Then execute",
      moveUp: "Move up",
      moveDown: "Move down",
      dragToReorder: "Drag to reorder",
      removeStep: "Remove step",
      importJson: "Import JSON",
      clearAll: "Clear all",
      noStepsAdded: "No steps added yet",
      inUseByTasks: "Used by {n} task(s)",
      notInUse: "Not used by any task",
      deleteInUseWarning: "These tasks are using it and will fall back to their defaults:",
      andNMore: "and {n} more",
      providersIntro:
        "Named browser backends. Pick one per task from a dropdown. Each backend has its own concurrency limit, independent of the others. Tasks set to \"Default\" use whichever one is marked default here.",
      addProvider: "Add provider",
      editProvider: "Edit provider",
      noProvidersYet: "No providers yet — add one to get started.",
      checkAll: "Check all",
      checkOne: "Check",
      healthCheckFailed: "Health check failed",
      concurrencyLimit: "Concurrency limit",
      concurrencyShort: "conc.",
      liveRunningQueued: "{r} running · {q} queued",
      setAsDefault: "Set as default",
      defaultBadge: "Default",
      defaultProviderHint: "Used by tasks set to \"Default\"",
      urlHintCdp: "CDP WebSocket endpoint (ws:// or wss://)",
      urlHintSidecar: "Sidecar HTTP address (http:// or https://), health-checked with GET /health",
      blockAdsLabel: "Block ads",
      ignoreHttpsErrors: "Ignore HTTPS errors",
      blockWebrtcLabel: "Block WebRTC",
      blockWebrtcHint: "Recommended. Leaving it off lets WebRTC leak an IP that may not match the proxy.",
      humanizeLabel: "Humanize (human-like cursor)",
      humanizeHint: "More human, but slower (Camoufox's own default is off)",
      sessionTimeoutMinutes: "Session timeout (minutes)",
      defaultResolution: "Default resolution",
      resolutionHint: "Only a default — when a fingerprint profile is selected, its own screen wins.",
      enabledLabel: "Enabled",
      disabledSuffix: "disabled",
      deleteProviderTitle: "Delete this provider?",
      deleteProviderDesc: "Tasks using it fall back to the default backend.",
      providerSaved: "Provider saved",
      providerUpdated: "Provider updated",
      providerDeleted: "Provider deleted",
      tasksFellBackToDefault: "{n} task(s) fell back to the default backend",
      nameAndUrlRequired: "Name and URL are required",
      fieldName: "Name",
      fieldType: "Type",
      actionSave: "Save",
      actionAdd: "Add",
      actionDelete: "Delete",
      proxiesTitle: "Proxies",
      proxiesIntro:
        "Reusable exit proxies. Add them once, then pick one per task from a dropdown. WARP is configured per task, not here.",
      addProxy: "Add proxy",
      editProxy: "Edit proxy",
      noProxiesYet: "No proxies yet.",
      proxyUrlLabel: "Proxy URL",
      proxyUrlHint: "Scheme required: http/https/socks5/vless/vmess/trojan/…",
      refreshExitAll: "Refresh all",
      refreshExitOne: "Refresh exit details",
      exitNotChecked: "Not checked",
      exitCheckFailed: "Check failed",
      exitCheckingInBackground: "Checking the exit IP in the background — refresh, or use the row's refresh button.",
      allProxiesRefreshed: "All proxies refreshed",
      failedToRefresh: "Failed to refresh",
      proxySaved: "Proxy saved",
      proxyUpdated: "Proxy updated",
      proxyDeleted: "Proxy deleted",
      deleteProxyTitle: "Delete this proxy?",
      deleteProxyDesc: "Tasks using it fall back to no proxy.",
      tasksFellBackToNoProxy: "{n} task(s) fell back to no proxy",
      nameAndProxyUrlRequired: "Name and proxy URL are required",
      fingerprintsTitle: "Browser fingerprints",
      fingerprintsIntro:
        "Reusable device fingerprints. Assign one to a task so it always looks like the SAME device — a real user has exactly one. Pick one per task from a dropdown.",
      addFingerprint: "Add fingerprint",
      editFingerprint: "Edit fingerprint",
      noFingerprintsYet: "No fingerprints yet.",
      operatingSystem: "Operating system",
      generateFingerprint: "Generate",
      generatedFixedOnSave: "Generated · fixed once saved",
      sourceBrowserforge: "browserforge (synthetic)",
      sourceRealPreset: "Real device preset",
      generateHint:
        "Generate produces one authentic, internally consistent fingerprint (applied at Camoufox's engine level) and pins it on save.",
      fingerprintGenerated: "Fingerprint generated — fixed once saved",
      generateFailed: "Generation failed",
      screenFixedByFingerprint: "fixed by the generated fingerprint",
      optionalSuffix: "optional",
      autoFromProxyIp: "leave empty to follow the proxy's exit IP",
      fingerprintSaved: "Fingerprint saved",
      fingerprintUpdated: "Fingerprint updated",
      fingerprintDeleted: "Fingerprint deleted",
      deleteFingerprintTitle: "Delete this fingerprint?",
      deleteFingerprintDesc: "Tasks using it fall back to the default fingerprint.",
      tasksFellBackToDefaultFp: "{n} task(s) fell back to the default fingerprint",
      nameRequired: "Name is required",
      gpuLabel: "GPU",
      screenLabel: "Screen",
      platformLabel: "Platform",
      cpuCoresLabel: "CPU cores",
      runDurationSuffix: "took",
      last24hOnly: "last 24h only",
      newGroup: "New group",
      groupName: "Group name",
      renameGroup: "Rename group",
      deleteGroupTitle: "Delete this group?",
      deleteGroupDesc: "Tasks in it are not deleted — they simply become ungrouped.",
      ungrouped: "Ungrouped",
      dragToReorderTasks: "Drag to reorder; drop on a group header to move it there",
      dragDisabledWhileFiltering: "Reordering is unavailable while filtering or searching",
      groupCreated: "Group created",
      groupUpdated: "Group updated",
      groupDeleted: "Group deleted",
      tasksUngrouped: "{n} task(s) are now ungrouped",
      orderSaved: "Order saved",
      failedToReorder: "Failed to save the order",
      resultsCount: "{n} results",
      enterValidUrl: "Enter a valid URL",
      tasksImportedDetail: "{n} task(s) imported — disabled, review before enabling",
      tasksSkipped: "; {n} skipped",
      fingerprintTip: "Fingerprint: {name}",
      fingerprintTipNone: "Fingerprint: no profile bound ({os})",
      screenshotExpired: "Screenshot expired",
      credentialsIntro: "Stored with AES-256-GCM encryption, reusable across tasks",
      hideValue: "Hide",
      showValue: "Show",
      leaveEmptyToKeep: "(leave empty to keep)",
      leaveEmptyKeepTotp: "Leave empty to keep the current 2FA",
      totpAutofillHint: "Used to auto-fill GitHub / Google two-factor prompts",
      timeoutSaved: "Task timeout saved",
      captchaNoneHint: "No captcha-solving service. A task that meets a captcha pauses and waits for a human.",
      maxQueueDepthLabel: "Max queue depth",
      concurrencyControl: "Concurrency",
      backendMovedToProviders: "Browser backends now live on the Providers page: add and edit them there (engine, address, stealth, ad blocking, HTTPS errors, session timeout, resolution, concurrency limit) and mark one as the default with ★. Tasks set to \"Default\" follow it.",
      goToProvidersPage: "Open the Providers page",
      noneValue: "None",
      defaultProviderIs: "Default ({name} · {type})",
      defaultProviderUnset: "Default (no default provider set)",
      autoFollowExitIp: "auto (follows the exit IP)",
      continueNextStep: "continue to the next step",
      exitTaskSuccess: "end · success",
      exitTaskFailure: "end · failure",
      cookieOnlyMethod: "Cookie only",
      requiredOneOfTwo: "one of these two is required",
      requiredSuffix: "required",
      optionalSeedSuffix: "optional, first-run seed",
      successTextPlaceholder: "Welcome, Dashboard, Signed in",
      successTextHint: "After the login completes, the page must contain this text — found means success, missing means failure.",
      cookieOnlyNeedsCriteria: "Cookie-only mode needs one of the two above: with no criterion there is no way to tell whether the cookie works, and every run reports it as invalid.",
      cookieOnlyExplain: "Cookie only: no automated login. The page is opened with the cookie you paste and passes if the success criterion matches; if it does not, the step fails outright (asking you to paste a fresh one) rather than continuing while logged out. After one success the real cookies are saved and take over.",
      cookieModeLabel: "Cookie mode (session persistence)",
      cookieModeHint: "Once enabled, a successful session (cookies + localStorage) is stored encrypted. The next run checks it first: still valid means the login is skipped, expired means it logs in again and re-saves.",
      sessionKeyHint: "Different keys store separate identities for the same task; empty uses \"default\".",
      cookiePasteHint: "Only the login ticket cookie is needed, not every cookie on the site. Its name differs per site (remember_web_* on Pterodactyl/Laravel panels, _github_session on GitHub) — find it under F12 → Application → Cookies, and separate several with ;. It is only a seed until a session has been stored; after one successful run the real cookies take over.",
      whenConditionTrue: "when true",
      elseWhenFalse: "Else — when false",
      timeoutMsLabel: "Timeout (ms)",
      dismissPopupsHint: "Dismisses cookie banners, overlays and ad layers so they cannot block later steps. No parameters.",
      maxConcurrentSessions: "Max concurrent sessions",
      queueWaitTimeout: "Queue wait timeout",
      taskNameRequired: "Task name is required",
      targetUrlRequired: "Target URL is required",
      cookieOnlyNoCriterionTitle: "Cookie-only login has no success criterion",
      cookieOnlyNoCriterionDesc: "Step {n}: fill in the success text or the success selector — without one there is no way to tell whether the cookie works.",
      unitDays: "days",
      unitHours: "hours",
      unitMinutes: "minutes",
      unitTimes: "runs",
      unitEvery: "every",
      randomWindowLabel: "Window (runs at a random moment inside it)",
      runsPerWindowLabel: "Runs per window",
      randomScheduleHint: "The next window starts when a run finishes, and {n} run(s) are scheduled at random inside it. \"3 days, 1 run\" means the next run happens at some random moment within 3 days of the last one finishing.",
      retryOnFailure: "Retry automatically on failure",
      retryAfterFailure: "After a failure, retry",
      retryTimesEvery: "times, waiting",
      retryHint: "Empty or 0 means no retry — the task simply waits for its next scheduled run. The count tracks CONSECUTIVE failures and resets after any success; once it is spent the task returns to its normal schedule. A run you cancel by hand is never retried.",
      webhookTrigger: "Webhook trigger",
      webhookIntro: "Lets an external monitor (Uptime Kuma and friends) fire this task by calling the URL when it sees a service go down.",
      autoGeneratedPlaceholder: "(generated automatically)",
      regenerate: "Regenerate",
      webhookUseThisEdit: "Configure your monitor like this (active once saved):",
      webhookUseThisNew: "After saving the task, call it like this:",
      taskIdPlaceholder: "<task-id>",
      webhookAuthHint: "A wrong token, a disabled webhook and a task that does not exist all return 401 alike, so the endpoint cannot be used to probe which tasks exist. A disabled task returns 409. It needs no login — the token is the only credential, so treat it like a password.",
      browserBackendSection: "Browser backend",
      defaultShort: "Default",
      backendSectionHint: "Pick a backend configured on the Providers page, and optionally a proxy / fingerprint just for this task.",
      providerOptionLine: "{name} ({type}, concurrency {n})",
      providerFieldHint: "Engine, address, stealth, resolution and the rest live on the Providers page, and each provider enforces its own concurrency limit. \"Default\" follows whichever one is starred there.",
      noDefaultProviderYet: "No default provider yet — set one on the Providers page.",
      proxyLabel: "Proxy",
      proxyNone: "None",
      proxyWarpRotate: "WARP (rotating)",
      proxyCustom: "Custom",
      proxySelectHint: "Choose a saved exit from the Proxies page, rotating WARP, or type an address.",
      proxyUrlPlaceholder: "socks5://user:pass@host:1080 or http/vless/vmess/trojan/hy2/tuic/ss://…",
      proxyCustomHint: "Paste the proxy URL — the scheme decides how it is dialled. http/socks5 are used directly; vless/vmess/trojan/hy2/tuic/ss start a local sing-box that exposes a SOCKS5 to the browser.",
      warpRotationsLabel: "Exit-IP rotations",
      warpRotationsPlaceholder: "empty = use the default (RECAPTCHA_MAX_IP_ROTATIONS, 5)",
      warpRotationsHint: "When reCAPTCHA refuses the audio challenge (\"automated queries\"), register a fresh WARP identity for a new exit IP and try again, up to this many times. sing-box restarts on the same local port, so the browser and page state survive; each retry also re-clicks the checkbox from the new IP, which sometimes passes outright. 0 disables it.",
      fingerprintFieldLabel: "Browser fingerprint",
      fingerprintNoneReal: "None (the browser's own fingerprint)",
      fingerprintHintCamoufox: "Only profiles saved on the Browser fingerprints page (applied at engine level, timezone and locale included). Generate a new one there.",
      fingerprintHintSb: "SeleniumBase can only spoof OS / timezone / locale — it cannot apply a generated fingerprint (browserforge or a real-device preset), so those profiles are hidden from this list.",
  };
  