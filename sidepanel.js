const out = document.getElementById('out')
const copyBtn = document.getElementById('copy')
const clearBtn = document.getElementById('clear')
const playBtn = document.getElementById('tts-play')
const pauseBtn = document.getElementById('tts-pause')
const stopBtn = document.getElementById('tts-stop')
const voiceSelect = document.getElementById('tts-voice')
const speedSelect = document.getElementById('tts-speed')
const ttsControls = document.getElementById('tts-controls')
const languageInfo = document.getElementById('language-info')
const languageNameEl = document.getElementById('language-name')

const storage =
  (chrome.storage && chrome.storage.session) ||
  (chrome.storage && chrome.storage.local) ||
  null

const supportsTts = Boolean(chrome?.tts)
let ttsAvailable = false
let preferredVoice = ''
let preferredRate = '1'
let speechSequence = 0
let ttsState = 'idle'

const languageDetectorApi = (() => {
  if (chrome?.ai?.languageDetector?.create) return chrome.ai.languageDetector
  if (globalThis?.ai?.languageDetector?.create) return globalThis.ai.languageDetector
  if (globalThis?.LanguageDetector?.create) return globalThis.LanguageDetector
  return null
})()

const supportsLanguageDetection = Boolean(languageDetectorApi?.create)
let detectionSupported = supportsLanguageDetection
let languageDetectorPromise = null
let detectedLanguageCode = ''
let detectionSequence = 0
let detectedLanguageProbability = null

const languageDisplayNames =
  typeof Intl?.DisplayNames === 'function'
    ? new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' })
    : null

let allVoices = []

const getSentence = () => out?.textContent || ''

function renderLanguageStatus ({ status, code, probability, note } = {}) {
  if (!languageNameEl || !languageInfo) return
  languageInfo.classList.remove('hidden')

  switch (status) {
    case 'detecting':
      languageNameEl.textContent = 'Detecting…'
      break
    case 'unavailable':
      languageNameEl.textContent = 'Detection unavailable'
      break
    case 'unknown':
      languageNameEl.textContent = 'Unknown'
      break
    case 'language': {
      const normalized = (code || '').toLowerCase()
      let label = normalized || 'Unknown'
      try {
        label = languageDisplayNames?.of
          ? languageDisplayNames.of(normalized) || normalized
          : normalized
      } catch {
        label = normalized || 'Unknown'
      }
      const confidence =
        typeof probability === 'number'
          ? ` (${Math.round(probability * 100)}%)`
          : ''
      const suffix = note ? ` — ${note}` : ''
      languageNameEl.textContent = `${label}${confidence}${suffix}`
      break
    }
    default:
      languageNameEl.textContent = '—'
  }
}

renderLanguageStatus({
  status: supportsLanguageDetection ? 'unknown' : 'unavailable'
})

function setTtsAvailability (enabled) {
  const next = Boolean(enabled && supportsTts)
  if (ttsControls) ttsControls.classList.toggle('hidden', !next)

  const controls = [playBtn, pauseBtn, stopBtn, voiceSelect, speedSelect]
  for (const el of controls) {
    if (!el) continue
    el.disabled = !next
  }

  if (next === ttsAvailable) {
    updateTtsUI()
    return
  }

  if (ttsAvailable && !next) stopSpeech()
  ttsAvailable = next
  updateTtsUI()
}

setTtsAvailability(false)

function updateTtsUI () {
  if (!ttsAvailable) return
  const hasText = Boolean(getSentence().trim())
  if (playBtn) playBtn.disabled = !hasText || ttsState === 'pending'
  if (pauseBtn) pauseBtn.disabled = ttsState !== 'speaking'
  if (stopBtn) stopBtn.disabled = ttsState === 'idle'
}

function stopSpeech (sendCommand = true) {
  if (sendCommand && supportsTts) {
    try {
      chrome.tts.stop()
      void chrome.runtime?.lastError
    } catch (e) {
      console.warn('tts.stop failed:', e)
    }
  }
  speechSequence++
  ttsState = 'idle'
  updateTtsUI()
}

function setSentence (text, { stop = true, detect = true } = {}) {
  const normalized = text || ''
  out.textContent = normalized
  if (stop) stopSpeech()
  else updateTtsUI()

  if (detect) queueLanguageDetection(normalized)
}

const persistSentence = text =>
  storage?.set?.({ lastSentence: text ?? '' }).catch(() => {})

const persistVoice = value =>
  storage?.set?.({ lastVoice: value ?? '' }).catch(() => {})

const persistRate = value =>
  storage?.set?.({ lastRate: value ?? '1' }).catch(() => {})

function speakSentence () {
  if (!ttsAvailable) return
  const text = getSentence().trim()
  if (!text) return

  stopSpeech()
  const token = ++speechSequence
  const rateValue = parseFloat(speedSelect?.value || preferredRate || '1')
  const rate = Number.isFinite(rateValue) && rateValue > 0 ? rateValue : 1
  const voiceName = voiceSelect?.value || undefined

  const onEvent = event => {
    if (token !== speechSequence) return
    if (event.type === 'start' || event.type === 'resume') {
      ttsState = 'speaking'
    } else if (event.type === 'pause') {
      ttsState = 'paused'
    } else if (
      event.type === 'end' ||
      event.type === 'interrupted' ||
      event.type === 'cancelled' ||
      event.type === 'error'
    ) {
      ttsState = 'idle'
    }
    updateTtsUI()
  }

  ttsState = 'pending'
  updateTtsUI()

  chrome.tts.speak(
    text,
    { voiceName, rate, enqueue: false, onEvent },
    () => {
      const err = chrome.runtime?.lastError
      if (err && token === speechSequence) {
        console.warn('tts.speak failed:', err.message)
        ttsState = 'idle'
        updateTtsUI()
      }
    }
  )
}

function pauseSpeech () {
  if (!ttsAvailable || ttsState !== 'speaking') return
  try {
    chrome.tts.pause()
    void chrome.runtime?.lastError
  } catch (e) {
    console.warn('tts.pause failed:', e)
  }
  ttsState = 'paused'
  updateTtsUI()
}

function resumeSpeechOrReplay () {
  if (!ttsAvailable) return
  if (ttsState === 'paused') {
    try {
      chrome.tts.resume()
      void chrome.runtime?.lastError
    } catch (e) {
      console.warn('tts.resume failed:', e)
    }
    ttsState = 'speaking'
    updateTtsUI()
    return
  }
  speakSentence()
}

function updateVoiceSelect (voices) {
  if (!voiceSelect) return

  voiceSelect.innerHTML = ''
  if (!voices.length) return

  const defaultOption = document.createElement('option')
  defaultOption.value = ''
  defaultOption.textContent = 'Default'
  voiceSelect.appendChild(defaultOption)

  let matched = false
  let firstVoiceName = ''
  for (const voice of voices) {
    if (!voice.voiceName) continue
    const option = document.createElement('option')
    option.value = voice.voiceName
    option.textContent = voice.lang
      ? `${voice.voiceName} (${voice.lang})`
      : voice.voiceName
    if (!matched && voice.voiceName === preferredVoice) {
      option.selected = true
      matched = true
    }
    voiceSelect.appendChild(option)
    if (!firstVoiceName) firstVoiceName = voice.voiceName
  }

  if (!matched && firstVoiceName) {
    voiceSelect.value = firstVoiceName
    preferredVoice = firstVoiceName
  } else if (!matched) {
    voiceSelect.value = ''
    preferredVoice = ''
  }
}

function languageMatchesVoice (languageCode, voice) {
  const voiceLang = (voice.lang || '').toLowerCase()
  if (!voiceLang) return false
  const normalized = languageCode.toLowerCase()
  return (
    voiceLang === normalized ||
    voiceLang.startsWith(`${normalized}-`) ||
    voiceLang.split('-')[0] === normalized
  )
}

function applyVoiceFilter () {
  if (!supportsTts) {
    setTtsAvailability(false)
    return 0
  }

  let voices = []
  if (!detectionSupported) {
    voices = allVoices.slice()
  } else if (detectedLanguageCode) {
    voices = allVoices.filter(voice =>
      languageMatchesVoice(detectedLanguageCode, voice)
    )
  } else {
    voices = []
  }

  updateVoiceSelect(voices)
  setTtsAvailability(voices.length > 0)

  if (detectionSupported && detectedLanguageCode) {
    const note =
      voices.length === 0 ? 'no voice available for this language' : undefined
    renderLanguageStatus({
      status: 'language',
      code: detectedLanguageCode,
      probability: detectedLanguageProbability,
      note
    })
  }

  return voices.length
}

function populateVoices () {
  if (!supportsTts) {
    setTtsAvailability(false)
    return
  }
  chrome.tts.getVoices(voices => {
    const err = chrome.runtime?.lastError
    if (err) {
      console.warn('tts.getVoices failed:', err.message)
      setTtsAvailability(false)
      return
    }
    allVoices = (voices || []).slice().sort((a, b) =>
      a.voiceName.localeCompare(b.voiceName)
    )
    applyVoiceFilter()
  })
}

async function getLanguageDetector () {
  if (!detectionSupported) return null
  if (!languageDetectorPromise) {
    languageDetectorPromise = languageDetectorApi
      .create()
      .catch(err => {
        console.warn('language detector init failed:', err)
        detectionSupported = false
        detectedLanguageCode = ''
        detectedLanguageProbability = null
        languageDetectorPromise = null
        renderLanguageStatus({ status: 'unavailable' })
        applyVoiceFilter()
        return null
      })
  }
  return languageDetectorPromise
}

async function queueLanguageDetection (rawText) {
  const text = (rawText || '').trim()

  if (!detectionSupported) {
    detectedLanguageCode = ''
    detectedLanguageProbability = null
    renderLanguageStatus({ status: 'unavailable' })
    applyVoiceFilter()
    return
  }

  if (!text) {
    detectedLanguageCode = ''
    detectedLanguageProbability = null
    renderLanguageStatus({ status: 'unknown' })
    applyVoiceFilter()
    return
  }

  const detector = await getLanguageDetector()
  if (!detector) {
    renderLanguageStatus({ status: 'unavailable' })
    applyVoiceFilter()
    return
  }

  const token = ++detectionSequence
  renderLanguageStatus({ status: 'detecting' })

  try {
    const result = await detector.detect(text)
    if (token !== detectionSequence) return

    let languageCode = ''
    let probability = null

    if (Array.isArray(result)) {
      const [top] = result
      languageCode =
        top?.languageCode ||
        top?.detectedLanguage ||
        top?.language ||
        ''
      probability =
        typeof top?.probability === 'number'
          ? top.probability
          : typeof top?.confidence === 'number'
          ? top.confidence
          : null
    } else if (result?.languages?.length) {
      const [top] = result.languages
      languageCode = top?.languageCode || ''
      probability =
        typeof top?.probability === 'number' ? top.probability : null
    }

    if (!languageCode) {
      detectedLanguageCode = ''
      detectedLanguageProbability = null
      renderLanguageStatus({ status: 'unknown' })
      applyVoiceFilter()
      return
    }

    detectedLanguageCode = languageCode.toLowerCase()
    detectedLanguageProbability =
      typeof probability === 'number' ? probability : null
    applyVoiceFilter()
  } catch (e) {
    if (token !== detectionSequence) return
    console.warn('language detection failed:', e)
    detectedLanguageCode = ''
    detectedLanguageProbability = null
    renderLanguageStatus({ status: 'unknown' })
    applyVoiceFilter()
  }
}

copyBtn?.addEventListener('click', async () => {
  const text = getSentence().trim()
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch (e) {
    console.warn('clipboard write failed:', e)
  }
})

clearBtn?.addEventListener('click', () => {
  setSentence('')
  persistSentence('')
})

playBtn?.addEventListener('click', () => {
  resumeSpeechOrReplay()
})

pauseBtn?.addEventListener('click', () => {
  pauseSpeech()
})

stopBtn?.addEventListener('click', () => {
  stopSpeech()
})

voiceSelect?.addEventListener('change', () => {
  preferredVoice = voiceSelect.value || ''
  persistVoice(preferredVoice)
})

speedSelect?.addEventListener('change', () => {
  preferredRate = speedSelect.value || '1'
  persistRate(preferredRate)
})

// 1) Restore last known values from storage
;(async () => {
  try {
    if (storage) {
      const data = await storage.get({
        lastSentence: '',
        lastVoice: '',
        lastRate: '1'
      })
      if (typeof data.lastVoice === 'string') preferredVoice = data.lastVoice
      if (typeof data.lastRate === 'string' || typeof data.lastRate === 'number')
        preferredRate = String(data.lastRate)
      if (speedSelect) {
        speedSelect.value = preferredRate
        if (speedSelect.value !== preferredRate) {
          speedSelect.value = '1'
          preferredRate = '1'
        }
      }
      if (data.lastSentence) {
        setSentence(data.lastSentence, { stop: false })
      } else {
        queueLanguageDetection('')
      }
    } else {
      queueLanguageDetection(getSentence())
    }
  } catch (e) {
    console.warn('storage.get failed:', e)
    queueLanguageDetection(getSentence())
  }

  if (supportsTts) populateVoices()
})()

if (supportsTts && chrome.tts.onVoicesChanged) {
  chrome.tts.onVoicesChanged.addListener(populateVoices)
}

// 2) Request the last sentence from background
;(async () => {
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'REQUEST_LAST_SENTENCE'
    })
    if (resp?.lastSentence && resp.lastSentence !== getSentence()) {
      setSentence(resp.lastSentence)
      persistSentence(resp.lastSentence)
    }
  } catch (e) {
    // background might be unavailable — not critical
  }
})()

// 3) Live updates from background/service worker
chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === 'SIDE_PANEL_TEXT') {
    setSentence(msg.payload || '')
    persistSentence(getSentence())
  }
})

updateTtsUI()
