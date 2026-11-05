# PrepPilot – Placement Prep Interview Coach (RAG-enabled)

PrepPilot is a React + Vite frontend with a FastAPI backend, Firebase Authentication, Gemini generation, and a retrieval-augmented generation (RAG) knowledge system.

## RAG features

- Built-in placement knowledge covering Python/OOP, SQL/DBMS, data structures and algorithms, aptitude, HR interviews, and machine learning.
- Authenticated students can upload PDF, DOCX, TXT, MD, and CSV study material (12 MB maximum per file).
- Text is extracted, split into overlapping chunks, embedded with Gemini `gemini-embedding-001`, and stored in a local SQLite vector index.
- Query embeddings are compared with stored vectors using cosine similarity. The best matching chunks are passed to Gemini as context.
- AI Mentor uses retrieval for every question and returns the names of retrieved sources.
- Mock Interview question generation and answer evaluation also receive retrieved placement knowledge.
- Technical Prep topics can be opened in the resource dialog and continued in AI Mentor, which retrieves relevant technical notes and uploaded documents.
- Uploaded document chunks are scoped to the signed-in Firebase UID. Built-in notes are shared read-only knowledge.

This is a lightweight SQLite-backed vector store (not ChromaDB). The SQLite database is created automatically at `backend/data/rag_vectors.sqlite3`. Do not commit this database because it may contain student-uploaded learning material. For cloud deployment, attach persistent disk storage to the backend or move the vector index to a managed vector database.

## Requirements

- Python 3.11 recommended
- Node.js 20+ (use a Node version supported by your installed Vite/Firebase packages)
- Firebase project with Email/Password authentication enabled
- Gemini API key with access to Gemini generation and embedding models
- Firebase Admin service-account JSON for backend token verification

## 1. Backend setup (PowerShell)

Open a terminal at the project root:

```powershell
cd backend
py -3.11 -m venv venv
.\venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
Copy-Item .env.example .env
```

Place your Firebase Admin service-account JSON in `backend` as `firebase-service-account.json`.

Edit `backend/.env`:

```env
GEMINI_API_KEY=YOUR_GEMINI_API_KEY
GEMINI_MODEL=gemini-3.1-flash-lite
GEMINI_EMBEDDING_MODEL=gemini-embedding-001
MONGODB_URI=
MONGODB_DATABASE=placement_prep
FRONTEND_ORIGIN=http://localhost:5173
FIREBASE_SERVICE_ACCOUNT=./firebase-service-account.json
```

Keep the real `.env` and Firebase JSON private. Start the API:

```powershell
uvicorn app.main:app --reload --port 8000
```

API docs: http://127.0.0.1:8000/docs

## 2. Frontend setup (second terminal)

```powershell
cd frontend
npm install
Copy-Item .env.example .env
```

Edit `frontend/.env` with the Firebase Web App values from Firebase Console:

```env
VITE_API_URL=http://localhost:8000
VITE_FIREBASE_API_KEY=YOUR_FIREBASE_WEB_API_KEY
VITE_FIREBASE_AUTH_DOMAIN=YOUR_PROJECT.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=YOUR_PROJECT_ID
VITE_FIREBASE_STORAGE_BUCKET=YOUR_PROJECT.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=YOUR_SENDER_ID
VITE_FIREBASE_APP_ID=YOUR_WEB_APP_ID
```

Start Vite:

```powershell
npm run dev
```

Open http://localhost:5173.

## 3. How to use RAG

1. Register/login with a verified Firebase email.
2. Open **AI Mentor**.
3. Upload a text-based PDF, DOCX, TXT, MD, or CSV file.
4. Wait for the “chunks indexed successfully” message.
5. Ask a question based on that document.
6. The response displays the names of the retrieved sources.
7. Generate/review a Mock Interview; it also retrieves relevant built-in and uploaded knowledge.
8. In Technical Prep, open a topic and choose **Practice with AI Mentor** to ask topic-specific questions using RAG.

Scanned image-only PDFs are not OCR-processed. Convert them to searchable PDFs or TXT before uploading. The first RAG request indexes built-in notes and may take longer because embeddings are generated.

## 4. Verify

- Backend: http://127.0.0.1:8000/api/health
- API docs: http://127.0.0.1:8000/docs
- Frontend: http://localhost:5173
- Upload endpoint: `POST /api/rag/upload` (requires Firebase bearer token)
- List personal documents: `GET /api/rag/documents` (requires Firebase bearer token)

## Limitations / deployment notes

- RAG requires a working Gemini API key for both embedding and generation calls. The first RAG request embeds the built-in notes.
- Local SQLite storage persists across local backend restarts but is not automatically shared across multiple backend instances. On a host with ephemeral filesystems, configure a persistent disk at the backend data directory.
- MongoDB is still separately used for student profile/progress persistence when `MONGODB_URI` is configured. RAG vectors currently use SQLite.
- Coding Lab remains a guided practice area; it does not execute untrusted code.
- Validate Firebase authorized domains, CORS origins, environment variables, and persistent storage before public deployment.
