import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'
import { createClient } from '@supabase/supabase-js'
import express from 'express'
import qrcode from 'qrcode'
import cors from 'cors'
import { rmSync, existsSync, mkdirSync } from 'fs'
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
    qr: null,
    phone: null
  }

  sock.ev.on('connection.update', async ({
    qr, connection, lastDisconnect
  }) => {

    if (qr) {
      const qrImage = await qrcode.toDataURL(qr)
      sessions[sessionId].qr = qrImage
      sessions[sessionId].status = 'waiting'

      await supabase
        .from('whatsapp_sessions')
        .update({
          status: 'waiting',
          updated_at: new Date().toISOString()
        })
        .eq('session_id', sessionId)
    }

    if (connection === 'open') {
      sessions[sessionId].status = 'connected'
      sessions[sessionId].qr = null
      sessions[sessionId].phone =
        sock.user?.id?.split(':')[0] || null

      await supabase
        .from('whatsapp_sessions')
        .update({
          status: 'connected',
          phone: sessions[sessionId].phone,
          updated_at: new Date().toISOString()
        })
        .eq('session_id', sessionId)

      console.log(`Session connected: ${label}`)
    }

    if (connection === 'close') {
      const code =
        lastDisconnect?.error?.output?.statusCode

      const loggedOut =
        code === DisconnectReason.loggedOut

      sessions[sessionId].status = 'disconnected'

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
        delete sessions[sessionId]
      } else {
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

      const isFromMe = msg.key.fromMe

      await supabase.from('messages').insert({
        agency_id: agencyId,
        session_id: sessionId,
        contact_number: contactNumber,
        body: body,
        direction: isFromMe ? 'out' : 'in',
        ai_generated: false,
        read: isFromMe,
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

  await startSession(sessionId, label, agencyId)

  res.json({
    success: true,
    sessionId,
    message: 'Session created, QR will be ready shortly'
  })
})

app.get('/api/sessions/:id/qr', (req, res) => {
  const session = sessions[req.params.id]

  if (!session) {
    return res.status(404).json({
      error: 'Session not found'
    })
  }

  res.json({
    qr: session.qr,
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
  const session = sessions[req.params.id]

  if (session?.sock) {
    try {
      await session.sock.logout()
    } catch (e) {}
    delete sessions[req.params.id]
  }

  await supabase
    .from('whatsapp_sessions')
    .update({ status: 'disconnected' })
    .eq('session_id', req.params.id)

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
  const { data, error } = await supabase
    .from('whatsapp_sessions')
    .select('*')

  if (error) return

  for (const session of data || []) {
    const authFolder = `./sessions/${session.session_id}`
    if (existsSync(authFolder)) {
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
  console.log(`LocaMS Baileys server running on port ${PORT}`)
  await restoreSessionsOnBoot()
})
