require('dotenv').config()
const axios = require('axios')
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

const SAFE_VOICE = '21m00Tcm4TlvDq8ikWAM' // Rachel — universal fallback

async function main() {
  // Fetch valid voice IDs from the new ElevenLabs account
  const resp = await axios.get('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
  })
  const validIds = new Set(resp.data.voices.map(v => v.voice_id))
  console.log('Valid voice IDs in new ElevenLabs account:', [...validIds])

  // Find all scripts with voice IDs not in the new account
  const scripts = await p.script.findMany({ select: { id: true, voiceId: true, name: true } })
  const bad = scripts.filter(s => !validIds.has(s.voiceId))

  console.log(`\nScripts with invalid voice IDs (${bad.length}):`)
  bad.forEach(s => console.log(` - ${s.name}: ${s.voiceId}`))

  if (bad.length === 0) {
    console.log('All voice IDs are valid!')
    return
  }

  const badIds = [...new Set(bad.map(s => s.voiceId))]
  const result = await p.script.updateMany({
    where: { voiceId: { in: badIds } },
    data: { voiceId: SAFE_VOICE }
  })
  console.log(`\nFixed ${result.count} scripts → Rachel (${SAFE_VOICE})`)
}

main()
  .catch(e => console.error('Error:', e.message))
  .finally(() => p.$disconnect())
