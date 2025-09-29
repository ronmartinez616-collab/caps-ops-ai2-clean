// Basic analytics endpoint.  In a real deployment you could
// store the payload in a database or log aggregator.  Here we
// simply acknowledge the event.  Accepts any JSON body via POST.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    // You could inspect req.body here and write to storage.
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Unexpected error' });
  }
}