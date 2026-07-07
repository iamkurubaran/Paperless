# Client Setup Guide

This directory contains the React + TypeScript frontend for Paperless.

## Requirements

- Node.js 18 or newer
- npm 9 or newer

## Install dependencies

From the repository root:

```bash
cd client
npm install
```

## Run the development server

```bash
npm run dev
```

The Vite dev server will start and usually be available at:

- http://localhost:5173

## Project notes

- API requests from the frontend are proxied to the backend during development.
- The app uses Vite, Tailwind CSS, and shadcn/ui components.
- Environment variables are typically handled through Vite's environment support.

## Useful commands

```bash
npm run build
npm run preview
npm run lint
```

## Troubleshooting

- If the app cannot connect to the backend, ensure the server is running on port 8000.
- If packages fail to install, remove `node_modules` and run `npm install` again.
- If you see a port conflict, Vite will usually suggest an alternate port.
