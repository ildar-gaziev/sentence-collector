const out = document.getElementById('out')
const copyBtn = document.getElementById('copy')
const clearBtn = document.getElementById('clear')
const playBtn = document.getElementById('tts-play')
const pauseBtn = document.getElementById('tts-pause')
const stopBtn = document.getElementById('tts-stop')
const voiceSelect = document.getElementById('tts-voice')
const speedSelect = document.getElementById('tts-speed')

const storage =
  (chrome.storage && chrome.storage.session) ||
  (chrome.storage && chrome.storage.local) ||
  null

let preferredVoice = ''
let preferredRate = '1'
let speechSequence = 0
let ttsState = 'idle'

const getSentence = () => out?.textContent || ''

const supportsTts = Boolean(chrome?.tts)
let ttsAvailable = supportsTts

function setTtsAvailability (enabled) {
  ttsAvailable = Boolean(enabled)
  if (!ttsAvailable) {
    playBtn?.setAttribute('disabled', 'disabled')
    pauseBtn?.setAttribute('disabled', 'disabled')
    stopBtn?.setAttribute('disabled', 'disabled')
    voiceSelect?.setAttribute('disabled', 'disabled')
    speedSelect?.setAttribute('disabled', 'disabled')
  } else {
    playBtn?.removeAttribute('disabled')
    pauseBtn?.removeAttribute('disabled')
    stopBtn?.removeAttribute('disabled')
    voiceSelect?.removeAttribute('disabled')
    speedSelect?.removeAttribute('disabled')
  }
}

if (!supportsTts) setTtsAvailability(false)

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

function setSentence (text, { stop = true } = {}) {
  out.textContent = text || ''
  if (stop) stopSpeech()
  else updateTtsUI()
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
      updateTtsUI()
    } else if (event.type === 'pause') {
      ttsState = 'paused'
      updateTtsUI()
    } else if (
      event.type === 'end' ||
      event.type === 'interrupted' ||
      event.type === 'cancelled' ||
      event.type === 'error'
    ) {
      ttsState = 'idle'
      updateTtsUI()
    }
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

function populateVoices () {
  if (!ttsAvailable || !voiceSelect) return
  chrome.tts.getVoices(voices => {
    const err = chrome.runtime?.lastError
    if (err) {
      console.warn('tts.getVoices failed:', err.message)
      setTtsAvailability(false)
      return
    }
    const list = (voices || []).slice()
    list.sort((a, b) => a.voiceName.localeCompare(b.voiceName))

    voiceSelect.innerHTML = ''
    const defaultOption = document.createElement('option')
    defaultOption.value = ''
    defaultOption.textContent = 'Default'
    voiceSelect.appendChild(defaultOption)

    let matched = false
    for (const voice of list) {
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
    }
    if (!matched) voiceSelect.value = ''
  })
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

// 1) Пробуем прочитать из storage
;(async () => {
  try {
    if (storage) {
      const data = await storage.get({
        lastSentence: '',
        lastVoice: '',
        lastRate: '1'
      })

      if (typeof data.lastVoice === 'string') {
        preferredVoice = data.lastVoice
      }
      if (typeof data.lastRate === 'string' || typeof data.lastRate === 'number') {
        preferredRate = String(data.lastRate)
      }
      if (speedSelect) {
        speedSelect.value = preferredRate
        if (speedSelect.value !== preferredRate) {
          speedSelect.value = '1'
          preferredRate = speedSelect.value
        }
      }
      if (data.lastSentence && !getSentence()) {
        setSentence(data.lastSentence, { stop: false })
      } else {
        updateTtsUI()
      }
    }
  } catch (e) {
    console.warn('storage.get failed:', e)
  }
  if (ttsAvailable) populateVoices()
})()

if (ttsAvailable && chrome.tts.onVoicesChanged) {
  chrome.tts.onVoicesChanged.addListener(populateVoices)
}

// 2) Запрашиваем у background (на случай, если сообщение пришло до инициализации)
;(async () => {
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'REQUEST_LAST_SENTENCE'
    })
    if (resp?.lastSentence && !getSentence()) {
      setSentence(resp.lastSentence)
      persistSentence(resp.lastSentence)
    }
  } catch (e) {
    // если фон недоступен — не критично
  }
})()

// 3) Живые сообщения (если фон отправит после открытия панели)
chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === 'SIDE_PANEL_TEXT') {
    setSentence(msg.payload || '')
    persistSentence(getSentence())
  }
})

updateTtsUI()
