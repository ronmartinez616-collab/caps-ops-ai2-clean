// The answer function accepts a POST request with { context, question }
// and uses OpenAI’s Chat Completions API to answer the question
// based solely on the provided context.  It uses a simple system
// prompt that instructs the model to rely on the context.  The
// OPENAI_API_KEY environment variable must be set in the serverless
// runtime.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const { context, question } = req.body || {};
    if (!question) {
      res.status(400).json({ error: 'Missing question' });
      return;
    }
    // Construct a prompt that embeds the context and instructs
    // the model to answer only from that context.  This helps
    // prevent hallucinations and keeps the answer grounded in
    // uploaded documents.
    const messages = [
      {
        role: 'system',
        content:
          'You are a helpful AI assistant for a restaurant franchise. Use the provided context from the operations manual to answer the user’s question. If the context does not contain the answer, say you do not know.'
      },
      {
        role: 'user',
        content: `${context}\n\nQuestion: ${question}`
      }
    ];
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages,
        temperature: 0.0
      })
    });
    if (!response.ok) {
      const errText = await response.text();
      res.status(response.status).json({ error: errText });
      return;
    }
    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content?.trim() || '';
    res.status(200).json({ answer });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Unexpected error' });
  }
}