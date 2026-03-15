import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'
import { createClient } from '@supabase/supabase-js'
import express from 'express'
import qrcode from 'qrcode'
import cors from 'cors'
import {
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync
} from 'fs'
import pino from 'pino'

const app = express()
app.use(express.json())
app.use(cors())

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

const sessions = {}
const logger = pino({ level: 'silent' })

const STATE_FILE = './sessions/state.json'

function saveStateToDisk() {
  try {
    if (!existsSync('./sessions')) {
      mkdirSync('./sessions', { recursive: true })
    }
    const state = Object.entries(sessions).map(
      ([id, s]) => ({
        sessionId: id,
        label: s.label,
        agencyId: s.agencyId,
        phone: s.phone,
        status: s.status
      })
    )
    writeFileSync(STATE_FILE, JSON.stringify(state))
  } catch (e) {
    console.log('Could not save state:', e.message)
  }
}

function loadStateFromDisk() {
  try {
    if (!existsSync(STATE_FILE)) return []
    const raw = readFileSync(STATE_FILE, 'utf8')
    return JSON.parse(raw)
  } catch (e) {
    return []
  }
}

function saveQRToDisk(sessionId, qrData) {
  try {
    const qrFile = `./sessions/${sessionId}_qr.txt`
    writeFileSync(qrFile, qrData)
  } catch (e) {}
}

function loadQRFromDisk(sessionId) {
  try {
    const qrFile = `./sessions/${sessionId}_qr.txt`
    if (existsSync(qrFile)) {
      return readFileSync(qrFile, 'utf8')
    }
  } catch (e) {}
  return null
}

function deleteQRFromDisk(sessionId) {
  try {
    const qrFile = `./sessions/${sessionId}_qr.txt`
    if (existsSync(qrFile)) {
      rmSync(qrFile)
    }
  } catch (e) {}
}

async function startSession(sessionId, label, agencyId) {
  const authFolder = `./sessions/${sessionId}`
  if (!existsSync(authFolder)) {
    mkdirSync(authFolder, { recursive: true })
  }

  const { state, saveCreds } =
    await useMultiFileAuthState(authFolder)

  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['LocaMS', 'Chrome', '1.0.0']
  })

  sessions[sessionId] = {
    sock,
    label,
    agencyId,
    status: 'connecting',
    qr: loadQRFromDisk(sessionId),
    phone: null
  }

  saveStateToDisk()

  sock.ev.on('connection.update', async ({
    qr, connection, lastDisconnect
  }) => {
    if (qr) {
      const qrImage = await qrcode.toDataURL(qr)
      sessions[sessionId].qr = qrImage
      sessions[sessionId].status = 'waiting'
      saveQRToDisk(sessionId, qrImage)
      saveStateToDisk()

      await supabase
        .from('whatsapp_sessions')
        .update({
          status: 'waiting',
          updated_at: new Date().toISOString()
        })
        .eq('session_id', sessionId)

      console.log('QR ready for:', label)
    }

    if (connection === 'open') {
      sessions[sessionId].status = 'connected'
      sessions[sessionId].qr = null
      sessions[sessionId].phone =
        sock.user?.id?.split(':')[0] || null

      deleteQRFromDisk(sessionId)
      saveStateToDisk()

      await supabase
        .from('whatsapp_sessions')
        .update({
          status: 'connected',
          phone: sessions[sessionId].phone,
          updated_at: new Date().toISOString()
        })
        .eq('session_id', sessionId)

      console.log('Connected:', label)
    }

    if (connection === 'close') {
      const code =
        lastDisconnect?.error?.output?.statusCode

      const loggedOut =
        code === DisconnectReason.loggedOut

      sessions[sessionId].status = 'disconnected'
      saveStateToDisk()

      await supabase
        .from('whatsapp_sessions')
        .update({
          status: 'disconnected',
          updated_at: new Date().toISOString()
        })
        .eq('session_id', sessionId)

      if (loggedOut) {
        rmSync(authFolder, {
          recursive: true,
          force: true
        })
        deleteQRFromDisk(sessionId)
        delete sessions[sessionId]
        saveStateToDisk()
        console.log('Logged out:', label)
      } else {
        console.log('Reconnecting:', label)
        setTimeout(() => {
          startSession(sessionId, label, agencyId)
        }, 5000)
      }
    }
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue
      if (msg.key.remoteJid === 'status@broadcast') continue

      const body =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        ''

      if (!body) continue

      const contactNumber =
        msg.key.remoteJid?.replace('@s.whatsapp.net', '')

      await supabase.from('messages').insert({
        agency_id: agencyId,
        session_id: sessionId,
        contact_number: contactNumber,
        body: body,
        direction: msg.key.fromMe ? 'out' : 'in',
        ai_generated: false,
        read: msg.key.fromMe,
        timestamp: new Date(
          Number(msg.messageTimestamp) * 1000
        ).toISOString()
      })
    }
  })
}

app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    sessions: Object.keys(sessions).length,
    timestamp: new Date().toISOString()
  })
})

app.get('/api/sessions', (req, res) => {
  const list = Object.entries(sessions).map(
    ([id, s]) => ({
      sessionId: id,
      label: s.label,
      status: s.status,
      phone: s.phone
    })
  )
  res.json(list)
})

app.post('/api/sessions/create', async (req, res) => {
  const { sessionId, label, agencyId } = req.body

  if (!sessionId || !label) {
    return res.status(400).json({
      error: 'sessionId and label are required'
    })
  }

  if (sessions[sessionId]) {
    return res.json({
      success: true,
      message: 'Session already exists'
    })
  }

  console.log('Creating session:', label, sessionId)
  startSession(sessionId, label, agencyId)

  res.json({
    success: true,
    sessionId,
    message: 'Session created'
  })
})

app.get('/api/sessions/:id/qr', (req, res) => {
  const sessionId = req.params.id
  const session = sessions[sessionId]

  if (!session) {
    const savedQR = loadQRFromDisk(sessionId)
    if (savedQR) {
      return res.json({
        qr: savedQR,
        status: 'waiting',
        phone: null
      })
    }
    return res.status(404).json({
      error: 'Session not found'
    })
  }

  const qr = session.qr || loadQRFromDisk(sessionId)

  res.json({
    qr: qr,
    status: session.status,
    phone: session.phone
  })
})

app.get('/api/sessions/:id/status', (req, res) => {
  const session = sessions[req.params.id]

  if (!session) {
    return res.json({ status: 'not_found' })
  }

  res.json({
    status: session.status,
    phone: session.phone,
    label: session.label
  })
})

app.delete('/api/sessions/:id', async (req, res) => {
  const sessionId = req.params.id
  const session = sessions[sessionId]

  if (session?.sock) {
    try {
      await session.sock.logout()
    } catch (e) {}
    delete sessions[sessionId]
  }

  deleteQRFromDisk(sessionId)
  saveStateToDisk()

  await supabase
    .from('whatsapp_sessions')
    .update({ status: 'disconnected' })
    .eq('session_id', sessionId)

  res.json({ success: true })
})

app.post('/api/sessions/:id/send', async (req, res) => {
  const { number, message } = req.body
  const session = sessions[req.params.id]

  if (!session?.sock) {
    return res.status(400).json({
      error: 'Session not connected'
    })
  }

  if (session.status !== 'connected') {
    return res.status(400).json({
      error: 'Session is not connected'
    })
  }

  try {
    const jid = number.includes('@')
      ? number
      : `${number}@s.whatsapp.net`

    await session.sock.sendMessage(jid, {
      text: message
    })

    res.json({ success: true })
  } catch (error) {
    res.status(500).json({
      error: 'Failed to send message',
      details: error.message
    })
  }
})

app.get('/api/sessions/:id/conversations',
  async (req, res) => {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('session_id', req.params.id)
    .order('timestamp', { ascending: false })

  if (error) {
    return res.status(500).json({ error: error.message })
  }

  const conversations = {}

  for (const msg of data || []) {
    const num = msg.contact_number
    if (!conversations[num]) {
      conversations[num] = {
        contact_number: num,
        last_message: msg.body,
        last_time: msg.timestamp,
        unread_count: 0,
        messages: []
      }
    }
    if (!msg.read && msg.direction === 'in') {
      conversations[num].unread_count++
    }
    conversations[num].messages.push(msg)
  }

  res.json(Object.values(conversations))
})

async function restoreSessionsOnBoot() {
  console.log('Restoring sessions...')

  const savedState = loadStateFromDisk()

  if (savedState.length > 0) {
    for (const s of savedState) {
      const authFolder = `./sessions/${s.sessionId}`
      if (existsSync(authFolder)) {
        console.log('Restoring:', s.label)
        await startSession(s.sessionId, s.label, s.agencyId)
        await new Promise(r => setTimeout(r, 2000))
      }
    }
    return
  }

  const { data, error } = await supabase
    .from('whatsapp_sessions')
    .select('*')

  if (error) return

  for (const session of data || []) {
    const authFolder = `./sessions/${session.session_id}`
    if (existsSync(authFolder)) {
      console.log('Restoring from Supabase:', session.label)
      await startSession(
        session.session_id,
        session.label,
        session.agency_id
      )
      await new Promise(r => setTimeout(r, 2000))
    }
  }
}

const PORT = process.env.PORT || 3001

app.listen(PORT, async () => {
  console.log('Server started on port', PORT)
  await restoreSessionsOnBoot()
})
