import React, { useState, useEffect, useRef } from 'react';
// We import the pdf.js library from pdfjs-dist.  This version of the
// library includes a fallback worker that can run parsing on the main
// thread when web workers are unavailable (e.g. in some preview
// environments).  See https://github.com/mozilla/pdf.js for details.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf';
import JSZip from 'jszip';

// This constant defines the path to the Capriotti’s logo that will be
// displayed in the header of the application.  The file lives in
// caps_ops_ai_final/public/logo.jpg and will be served by Vite at
// runtime.  Do not include the ``public`` prefix when referencing
// assets in React; Vite automatically exposes assets at the root.
const LOGO_URL = '/logo.jpg';

/*
 * Utility functions for text processing and similarity.  These
 * functions provide basic tokenization, cosine similarity and
 * fallback keyword matching for when an embedding cannot be
 * generated.  They do not require external libraries and run in
 * the browser.
 */

// Split a string into lowercase alphanumeric tokens.  Any non‑word
// characters become delimiters.  If the input is undefined or empty
// we return an empty array.
function tokenize(str) {
  if (!str) return [];
  return str
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Compute the dot product between two numeric vectors.  Used by
// cosineSim below.
function dot(a, b) {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) sum += a[i] * b[i];
  return sum;
}

// Compute cosine similarity between two vectors.  If either vector has
// zero magnitude the similarity will be zero.
function cosineSim(a, b) {
  const num = dot(a, b);
  let magA = 0;
  let magB = 0;
  for (const x of a) magA += x * x;
  for (const x of b) magB += x * x;
  return magA && magB ? num / Math.sqrt(magA * magB) : 0;
}

// Attempt to fetch an embedding for a piece of text by calling
// the local /api/embed endpoint.  If the endpoint fails (for
// example because no API key is configured) we return null.  The
// serverless function is implemented under caps_ops_ai_final/api/embed.js.
async function fetchEmbedding(text) {
  try {
    const resp = await fetch('/api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text })
    });
    if (!resp.ok) throw new Error('embed failed');
    const data = await resp.json();
    return data.embedding;
  } catch (err) {
    console.warn('Embedding unavailable:', err);
    return null;
  }
}

// Call the answer API to generate a final answer given some context
// chunks and the user’s question.  The serverless function at
// /api/answer is responsible for formatting a system prompt and
// interacting with OpenAI.  We expect it to return a JSON object
// containing an ``answer`` string.
async function callAnswerAPI(context, question) {
  try {
    const resp = await fetch('/api/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, question })
    });
    if (!resp.ok) throw new Error('answer failed');
    const data = await resp.json();
    return data.answer;
  } catch (err) {
    console.warn('Answer API unavailable:', err);
    return 'Sorry, I was unable to generate an answer at this time.';
  }
}

// Generate a random identifier using the browser’s crypto API.  This
// is used to uniquely identify documents and chunks.  It avoids the
// need for an external uuid library.
function uuid() {
  // crypto.randomUUID is supported in modern browsers.  Fallback to
  // a simpler random string if unavailable.
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Main React component
function App() {
  // ``mode`` toggles between 'admin' and 'partner'.  Admins can
  // upload documents and publish them; partners can only search
  // content once logged in with the shared password.
  const [mode, setMode] = useState('admin');
  const [password, setPassword] = useState('');
  const [partnerLoggedIn, setPartnerLoggedIn] = useState(false);

  // Documents and chunk index.  Each document has id, name,
  // pages and content.  The index stores objects { id, docId, text, embedding }.
  const [docs, setDocs] = useState([]);
  const [index, setIndex] = useState([]);

  // Question/answer state
  const [query, setQuery] = useState('');
  const [answer, setAnswer] = useState(null);

  // Diagnostics: record boot time for user feedback
  const [bootTimeMs, setBootTimeMs] = useState(null);

  // File input ref
  const fileInputRef = useRef(null);

  // On mount, record boot time and hydrate any preloaded docs
  useEffect(() => {
    const start = performance.now();
    // Preload docs and index if provided by server (for partner mode)
    if (typeof window !== 'undefined' && window.__CAPS_PRELOADED__) {
      const { docs: preDocs = [], index: preIndex = [] } = window.__CAPS_PRELOADED__;
      setDocs(preDocs);
      setIndex(preIndex);
    }
    const end = performance.now();
    setBootTimeMs(Math.round(end - start));
  }, []);

  // Handle toggling between admin and partner view.  Reset partner
  // login state when switching away from partner mode.
  function toggleMode() {
    setMode(prev => (prev === 'admin' ? 'partner' : 'admin'));
    // Reset login when leaving partner mode
    if (mode === 'partner') setPartnerLoggedIn(false);
  }

  // Simple password check for partner mode.  In a real app you
  // should never embed secrets in client code; instead protect the
  // route on the server.  Here we accept any non‑empty password for
  // demonstration.
  function handlePartnerLogin(e) {
    e.preventDefault();
    // If you wish to enforce a specific password, replace the
    // condition below with a constant or environment variable check.
    if (password.trim() !== '') {
      setPartnerLoggedIn(true);
    }
  }

  // Parse a single PDF file and return an object containing the
  // extracted text and page count.  If pdf.js fails to load (for
  // example because of network or CSP restrictions) we skip parsing
  // and return an empty string.  Admins can later re‑parse the file
  // after deployment via the "Parse Later" mechanism or attach text
  // manually.
  async function extractPdf(file) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer, disableWorker: true }).promise;
      let fullText = '';
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const content = await page.getTextContent();
        const strings = content.items.map(item => item.str).join(' ');
        fullText += `\n\n${strings}`;
      }
      return { text: fullText, pages: pdf.numPages };
    } catch (err) {
      console.warn('PDF parsing failed:', err);
      return { text: '', pages: 0 };
    }
  }

  // Handle file selection from the file input.  We support multiple
  // files at once.  For each file we create a document entry and
  // chunk it into segments of about 500 characters.  We then call
  // fetchEmbedding on each chunk to build the index.  If embeddings
  // are unavailable we still store the chunks with a null embedding
  // so that fallback keyword search works.
  async function handleFileUpload(event) {
    const files = Array.from(event.target.files || []);
    for (const file of files) {
      const { text, pages } = await extractPdf(file);
      const docId = uuid();
      const newDoc = { id: docId, name: file.name, pages, content: text };
      const newChunks = [];
      // Split into roughly 500 character chunks to limit context size
      const size = 500;
      for (let i = 0; i < text.length; i += size) {
        const chunkText = text.slice(i, i + size);
        const chunkId = uuid();
        const embed = await fetchEmbedding(chunkText);
        newChunks.push({ id: chunkId, docId, text: chunkText, embedding: embed });
      }
      setDocs(prev => [...prev, newDoc]);
      setIndex(prev => [...prev, ...newChunks]);
    }
    // Reset the file input so the same file can be selected again
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  // Perform a search and generate an answer.  We compute an
  // embedding for the user’s query if possible; otherwise fall back
  // to a simple keyword match.  Top chunks are concatenated to form
  // context for the answer API.
  async function handleAsk() {
    const question = query.trim();
    if (!question) return;
    setAnswer(null);
    // Attempt to embed the question
    const qEmbedding = await fetchEmbedding(question);
    let scored = [];
    if (qEmbedding) {
      scored = index.map(ch => ({ ...ch, score: cosineSim(qEmbedding, ch.embedding || []) }));
    } else {
      // Fallback: count overlapping tokens between query and chunk
      const qTokens = tokenize(question);
      scored = index.map(ch => {
        const cTokens = tokenize(ch.text);
        const matches = qTokens.filter(t => cTokens.includes(t)).length;
        return { ...ch, score: matches };
      });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 5);
    const context = top.map(ch => ch.text).join('\n---\n');
    const answerText = await callAnswerAPI(context, question);
    setAnswer({ text: answerText, sources: top });
  }

  // Allow the admin to download a text file containing the full
  // contents of a document.  This makes it easy to inspect the
  // extracted text or share the document outside of the app.
  function downloadDoc(doc) {
    const blob = new Blob([doc.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${doc.name.replace(/\.[^/.]+$/, '')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Render the header with logo and mode toggle.  For partner mode,
  // prompt for a password if not yet logged in.
  function renderHeader() {
    return (
      <header className="bg-white shadow p-4 flex justify-between items-center">
        <div className="flex items-center space-x-3">
          <img src={LOGO_URL} alt="Capriotti’s" className="h-12" />
          <h1 className="text-xl font-semibold">CAPS Ops AI</h1>
        </div>
        <div className="flex items-center space-x-4">
          <span className="text-sm text-gray-500">Mode: {mode}</span>
          <button
            onClick={toggleMode}
            className="px-3 py-1 bg-blue-600 text-white rounded"
          >
            {mode === 'admin' ? 'Switch to Partner' : 'Switch to Admin'}
          </button>
        </div>
      </header>
    );
  }

  // Render the partner login form.  Once logged in, the partner
  // document library and question interface will appear.
  function renderPartnerLogin() {
    return (
      <div className="p-4 max-w-md mx-auto">
        <h2 className="text-lg font-semibold mb-2">Partner Login</h2>
        <form onSubmit={handlePartnerLogin} className="space-y-2">
          <input
            type="password"
            className="w-full border rounded p-2"
            placeholder="Enter password"
            value={password}
            onChange={e => setPassword(e.target.value)}
          />
          <button type="submit" className="w-full bg-blue-600 text-white p-2 rounded">Login</button>
        </form>
      </div>
    );
  }

  // Render the document library.  In admin mode we show an upload
  // button; in partner mode the documents are read‑only.  Each
  // document row also shows a download button in admin mode.
  function renderLibrary() {
    return (
      <div className="p-4 space-y-2">
        <div className="flex justify-between items-center">
          <h2 className="text-lg font-semibold">Document Library</h2>
          {mode === 'admin' && (
            <input
              type="file"
              multiple
              accept="application/pdf"
              ref={fileInputRef}
              onChange={handleFileUpload}
              className="border p-1 rounded"
            />
          )}
        </div>
        <ul className="divide-y divide-gray-200 border rounded bg-white">
          {docs.map(doc => (
            <li key={doc.id} className="p-2 flex justify-between items-center">
              <span>{doc.name} {doc.pages ? `(${doc.pages} pages)` : ''}</span>
              {mode === 'admin' && (
                <button
                  onClick={() => downloadDoc(doc)}
                  className="px-2 py-1 text-sm bg-gray-200 rounded"
                >
                  Download Text
                </button>
              )}
            </li>
          ))}
          {docs.length === 0 && (
            <li className="p-2 text-sm text-gray-500">No documents uploaded yet.</li>
          )}
        </ul>
      </div>
    );
  }

  // Render the question/answer panel.  Both admin and partner (once
  // logged in) can ask questions.  Display the answer and cite
  // sources by listing the originating documents and chunk IDs.
  function renderQA() {
    return (
      <div className="p-4 space-y-2">
        <h2 className="text-lg font-semibold">Ask a Question</h2>
        <div className="flex space-x-2">
          <input
            type="text"
            className="flex-1 border rounded p-2"
            placeholder="Type your question here"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleAsk();
            }}
          />
          <button
            onClick={handleAsk}
            className="px-4 py-2 bg-green-600 text-white rounded"
          >
            Ask
          </button>
        </div>
        {answer && (
          <div className="mt-4 p-3 border rounded bg-white space-y-2">
            <p>{answer.text}</p>
            <div>
              <h3 className="text-sm font-semibold">Sources</h3>
              <ul className="list-disc list-inside text-xs text-blue-700">
                {answer.sources.map((ch, idx) => {
                  const doc = docs.find(d => d.id === ch.docId);
                  return (
                    <li key={idx}>
                      {doc ? doc.name : 'Unknown document'} – chunk {ch.id.slice(0, 8)}
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-gray-100">
      {renderHeader()}
      <main className="flex-1">
        {/* Diagnostics for debugging and user feedback */}
        <div className="text-xs text-gray-500 italic p-2">Boot: {bootTimeMs} ms</div>
        {mode === 'partner' && !partnerLoggedIn ? (
          renderPartnerLogin()
        ) : (
          <>
            {renderLibrary()}
            {renderQA()}
          </>
        )}
      </main>
    </div>
  );
}

export default App;