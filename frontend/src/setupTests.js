// src/setupTests.js
import React from 'react';
import '@testing-library/jest-dom';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Run cleanup after each test case (e.g., clearing jsdom)
afterEach(() => {
  cleanup();
});

// You can add other global setup here if needed, e.g.:
// - Mocking global objects (fetch, localStorage)
// - Setting up MSW (Mock Service Worker) 
