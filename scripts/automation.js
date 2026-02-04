import Imap from 'imapflow'
import { simpleParser } from 'mailparser'
import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

// Load .env file
dotenv.config()

// Read from environment variables
const GMAIL_USER = process.env.GMAIL_USER
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD
const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_ANON_KEY

// Validate required env vars
if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials')
  console.error('SUPABASE_URL:', supabaseUrl ? 'set' : 'missing')
  console.error('SUPABASE_ANON_KEY:', supabaseKey ? 'set' : 'missing')
  process.exit(1)
}

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY')
  process.exit(1)
}

if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
  console.error('Missing Gmail credentials')
  process.exit(1)
}

console.log('Environment loaded successfully')

const supabase = createClient(supabaseUrl, supabaseKey)
const openai = new OpenAI({ apiKey: OPENAI_API_KEY })

async function parseAlert(email) {
  const text = email.text || ''
  const html = email.html || ''

  const queryMatch = email.subject.match(/Google Alert for:\s*(.+)/i)
  const query = queryMatch ? queryMatch[1].trim() : ''

  const urlMatch = text.match(/https?:\/\/[^\s\n]+/i) || html.match(/https?:\/\/[^\s\n]+/i)
  const url = urlMatch ? urlMatch[0] : ''

  let title = query
  let snippet = text.substring(0, 500)

  if (html) {
    const titleMatch = html.match(/<h3[^>]*>(.*?)<\/h3>/i)
    if (titleMatch) title = titleMatch[1].replace(/<[^>]+>/g, '').trim()

    const snippetMatch = html.match(/<p[^>]*>(.*?)<\/p>/i)
    if (snippetMatch) snippet = snippetMatch[1].replace(/<[^>]+>/g, '').trim()
  }

  return { query, url, title, snippet, date: email.date }
}

async function generateContentIdea(alert) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are a medical tourism content strategist. Return valid JSON.' },
      {
        role: 'user',
        content: `Generate blog post idea from this alert: ${JSON.stringify(alert)}. Return JSON with: suggested_title, target_keywords, target_audience, search_intent, suggested_outline, word_count_estimate, seo_priority_score, topic, urgency`
      }
    ],
    temperature: 0.7,
    max_tokens: 1500,
    response_format: { type: 'json_object' }
  })

  return JSON.parse(response.choices[0].message.content)
}

function generateSlug(text) {
  return text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').substring(0, 100)
}

async function saveContentIdea(alert, idea) {
  const { error } = await supabase.from('content_ideas').insert({
    title: `Content Idea: ${alert.title}`,
    slug: generateSlug(idea.suggested_title),
    source: 'google_alerts',
    topic: idea.topic,
    urgency: idea.urgency,
    alert_query: alert.query,
    alert_date: alert.date?.toISOString(),
    original_url: alert.url,
    source_title: alert.title,
    source_snippet: alert.snippet,
    target_keywords: idea.target_keywords,
    target_audience: idea.target_audience,
    search_intent: idea.search_intent,
    suggested_title: idea.suggested_title,
    suggested_outline: idea.suggested_outline,
    word_count_estimate: idea.word_count_estimate,
    seo_priority_score: idea.seo_priority_score,
    status: 'pending'
  })

  if (error) {
    console.error('Supabase insert error:', error.message)
    throw error
  }
}

async function markAsRead(client, uid) {
  await client.messageFlagsAdd(uid, ['\\Seen'])
}

async function runAutomation() {
  console.log('Starting content automation...')

  let processed = 0
  let skipped = 0
  let errors = 0

  const client = new Imap({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    logger: false
  })

  try {
    await client.connect()
    console.log('Connected to Gmail')

    await client.mailboxOpen('INBOX')

    const messages = await client.search({
      from: 'googlealerts-noreply@google.com',
      seen: false
    })

    console.log(`Found ${messages.length} unread Google Alerts`)

    if (messages.length === 0) {
      console.log('No new alerts to process')
      return
    }

    for (const uid of messages) {
      const message = await client.fetchOne(uid, { source: true })
      const email = await simpleParser(message.source)

      try {
        const alert = await parseAlert(email)

        if (!alert.query) {
          console.log('Skipped: not a Google Alert')
          skipped++
          await markAsRead(client, uid)
          continue
        }

        console.log('Processing:', alert.query)
        const idea = await generateContentIdea(alert)
        await saveContentIdea(alert, idea)
        await markAsRead(client, uid)

        processed++
        console.log('Saved:', idea.suggested_title)

      } catch (error) {
        console.error('Error processing email:', error.message)
        errors++
        await markAsRead(client, uid)
      }
    }

    console.log(`\nSummary: ${processed} processed, ${skipped} skipped, ${errors} errors`)

  } catch (error) {
    console.error('Automation error:', error.message)
    process.exit(1)
  } finally {
    if (client) await client.logout()
  }
}

runAutomation()
