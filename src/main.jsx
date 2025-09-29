import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

// Mount the React application into the root div
createRoot(document.getElementById('root')).render(<App />);