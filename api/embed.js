// The embed function exposes a simple API for generating vector
// embeddings via the OpenAI API.  It expects a POST request with
// JSON body of the form { input: "some text" }.  The serverless
// runtime must have the OPENAI_API_KEY environment variable set.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const { input } = req.body || {};
    if (!input || typeof input !== 'string') {
      res.status(400).json({ error: 'Missing input' });
      return;
    }
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'text-embedding-ada-002',
        input
      })
    });
    if (!response.ok) {
      const err = await response.text();
      res.status(response.status).json({ error: err });
      return;
    }
    const data = await response.json();
    const embedding = data?.data?.[0]?.embedding || [];
    res.status(200).json({ embedding });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Unexpected error' });
  }
}