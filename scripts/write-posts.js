import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_ANON_KEY
const OPENAI_API_KEY = process.env.OPENAI_API_KEY

if (!supabaseUrl || !supabaseKey || !OPENAI_API_KEY) {
  console.error('Missing required environment variables')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)
const openai = new OpenAI({ apiKey: OPENAI_API_KEY })

const POSTS_PER_DAY = 3

async function getPendingIdeas() {
  const { data, error } = await supabase
    .from('content_ideas')
    .select('*')
    .eq('status', 'pending')
    .order('seo_priority_score', { ascending: false })
    .limit(POSTS_PER_DAY)

  if (error) {
    console.error('Error fetching ideas:', error.message)
    return []
  }

  return data || []
}

async function generateBlogPost(idea) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `You are a professional medical tourism content writer for Meet Your Clinic.
Write informative, trustworthy content for people considering medical procedures abroad.
Tone: Professional, empathetic, factual. Never salesy or tacky.
Include: Benefits, risks, what to expect, recovery, cost factors.
Format: Use markdown with H2/H3 headings, bullet points where appropriate.
Length: ${idea.word_count_estimate || 1500} words.`
      },
      {
        role: 'user',
        content: `Write a blog post based on this brief:

Title: ${idea.suggested_title}
Topic: ${idea.topic}
Target Keywords: ${JSON.stringify(idea.target_keywords)}
Target Audience: ${idea.target_audience}
Search Intent: ${idea.search_intent}
Outline: ${JSON.stringify(idea.suggested_outline)}

Write the full blog post in markdown format.`
      }
    ],
    temperature: 0.7,
    max_tokens: 4000
  })

  return response.choices[0].message.content
}

async function generateMetaDescription(title, content) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: 'Write a compelling meta description for SEO. Max 155 characters. No quotes.'
      },
      {
        role: 'user',
        content: `Title: ${title}\n\nContent preview: ${content.substring(0, 500)}`
      }
    ],
    max_tokens: 100
  })

  return response.choices[0].message.content.trim()
}

function generateSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 80)
}

function generateExcerpt(content) {
  // Strip markdown and get first 160 chars
  const plain = content
    .replace(/#{1,6}\s/g, '')
    .replace(/\*\*/g, '')
    .replace(/\n/g, ' ')
    .trim()
  return plain.substring(0, 160) + '...'
}

function calculateReadingTime(content) {
  const words = content.split(/\s+/).length
  return Math.ceil(words / 200)
}

function generateCategorySlug(category) {
  if (!category) return null
  return category.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-')
}

async function saveBlogPost(idea, content, metaDescription) {
  const slug = generateSlug(idea.suggested_title)

  const { error } = await supabase.from('blog_posts').insert({
    title: idea.suggested_title,
    slug: slug,
    excerpt: generateExcerpt(content),
    content: content,
    meta_title: idea.suggested_title,
    meta_description: metaDescription,
    keywords: idea.target_keywords,
    category: idea.topic,
    category_slug: generateCategorySlug(idea.topic),
    reading_time: calculateReadingTime(content),
    author_name: 'Meet Your Clinic',
    status: 'draft',
    source_idea_id: idea.id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  })

  if (error) {
    console.error('Error saving post:', error.message)
    throw error
  }

  return slug
}

async function markIdeaAsProcessed(ideaId) {
  const { error } = await supabase
    .from('content_ideas')
    .update({ status: 'processed' })
    .eq('id', ideaId)

  if (error) {
    console.error('Error updating idea status:', error.message)
  }
}

async function run() {
  console.log('Starting blog post generation...')

  const ideas = await getPendingIdeas()
  console.log(`Found ${ideas.length} pending ideas`)

  if (ideas.length === 0) {
    console.log('No pending ideas to process')
    return
  }

  let written = 0
  let errors = 0

  for (const idea of ideas) {
    try {
      console.log(`\nWriting: ${idea.suggested_title}`)

      const content = await generateBlogPost(idea)
      const metaDescription = await generateMetaDescription(idea.suggested_title, content)
      const slug = await saveBlogPost(idea, content, metaDescription)
      await markIdeaAsProcessed(idea.id)

      written++
      console.log(`Saved draft: /blog/${slug}`)

    } catch (error) {
      console.error(`Error processing idea ${idea.id}:`, error.message)
      errors++
    }
  }

  console.log(`\nSummary: ${written} posts written, ${errors} errors`)
}

run()
