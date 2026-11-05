import os
import io
import json
import math
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import httpx
import firebase_admin
from dotenv import load_dotenv
from firebase_admin import credentials, auth as firebase_auth
from fastapi import FastAPI, HTTPException, Request, UploadFile, File
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


# ==================================================
# ENVIRONMENT CONFIGURATION
# ==================================================

load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite")

FRONTEND_ORIGIN = os.getenv(
    "FRONTEND_ORIGIN",
    "http://localhost:5173"
)

MONGODB_URI = os.getenv("MONGODB_URI")
MONGODB_DATABASE = os.getenv("MONGODB_DATABASE", "placement_prep")

FIREBASE_SERVICE_ACCOUNT = os.getenv(
    "FIREBASE_SERVICE_ACCOUNT",
    "./firebase-service-account.json"
)

BACKEND_DIR = Path(__file__).resolve().parent.parent
SERVICE_ACCOUNT_PATH = Path(FIREBASE_SERVICE_ACCOUNT)

if not SERVICE_ACCOUNT_PATH.is_absolute():
    SERVICE_ACCOUNT_PATH = (
        BACKEND_DIR / SERVICE_ACCOUNT_PATH
    ).resolve()

if not SERVICE_ACCOUNT_PATH.is_file():
    raise RuntimeError(
        "Firebase service account JSON not found. "
        "Check FIREBASE_SERVICE_ACCOUNT in backend/.env"
    )

try:
    firebase_admin.get_app()
except ValueError:
    credential = credentials.Certificate(
        str(SERVICE_ACCOUNT_PATH)
    )
    firebase_admin.initialize_app(credential)


# ==================================================
# FASTAPI APPLICATION
# ==================================================

app = FastAPI(
    title="Placement Prep Interview Coach API",
    description="AI-powered placement preparation platform",
    version="1.2.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        FRONTEND_ORIGIN,
        "http://localhost:5173",
        "http://127.0.0.1:5173"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)


# ==================================================
# FIREBASE AUTHENTICATION MIDDLEWARE
# ==================================================

PUBLIC_PATHS = {
    "/",
    "/api/health",
    "/docs",
    "/docs/oauth2-redirect",
    "/openapi.json",
    "/redoc"
}


@app.middleware("http")
async def firebase_auth_middleware(request: Request, call_next):

    path = request.url.path

    if request.method == "OPTIONS":
        return await call_next(request)

    if path in PUBLIC_PATHS or not path.startswith("/api/"):
        return await call_next(request)

    authorization = request.headers.get("Authorization", "")

    if not authorization.startswith("Bearer "):
        return JSONResponse(
            status_code=401,
            content={"detail": "Authentication required."}
        )

    id_token = authorization.split(" ", 1)[1].strip()

    try:
        decoded_token = firebase_auth.verify_id_token(id_token)

        if not decoded_token.get("email_verified", False):
            return JSONResponse(
                status_code=403,
                content={
                    "detail": "Please verify your email address."
                }
            )

        request.state.firebase_user = decoded_token

    except Exception:
        return JSONResponse(
            status_code=401,
            content={
                "detail": "Invalid or expired authentication token."
            }
        )

    return await call_next(request)


# ==================================================
# DATABASE CONFIGURATION
# ==================================================

mongo_client = None
db = None

try:
    if MONGODB_URI:
        from pymongo import MongoClient

        mongo_client = MongoClient(
            MONGODB_URI,
            serverSelectionTimeoutMS=3000
        )

        mongo_client.admin.command("ping")
        db = mongo_client[MONGODB_DATABASE]

        print("MongoDB connected successfully.")

    else:
        print("MongoDB URI not configured. Using demo storage.")

except Exception as error:
    mongo_client = None
    db = None
    print(f"MongoDB connection failed: {error}")
    print("Using demo storage.")


# Progress is separated by Firebase user ID.
# It resets when the backend restarts.

demo_progress_by_user = {}
demo_profiles_by_user = {}


def get_user_progress(request: Request):
    """Load progress for the authenticated Firebase user."""
    user_id = request.state.firebase_user["uid"]

    if user_id not in demo_progress_by_user:
        default_progress = {
            "aptitude_attempts": 0,
            "aptitude_correct": 0,
            "mock_interviews": 0,
            "recent_activity": []
        }
        if db is not None:
            saved = db.student_progress.find_one({"_id": user_id})
            if saved:
                saved.pop("_id", None)
                default_progress.update(saved)
        demo_progress_by_user[user_id] = default_progress

    return demo_progress_by_user[user_id]


def save_user_progress(request: Request, progress: dict):
    """Persist progress when MongoDB is configured; retain demo fallback otherwise."""
    user_id = request.state.firebase_user["uid"]
    demo_progress_by_user[user_id] = progress
    if db is not None:
        db.student_progress.update_one(
            {"_id": user_id},
            {"$set": dict(progress)},
            upsert=True
        )


# ==================================================
# RAG KNOWLEDGE BASE (SQLite-backed vector store)
# ==================================================

RAG_DIR = BACKEND_DIR / "data"
RAG_DIR.mkdir(parents=True, exist_ok=True)
RAG_DB_PATH = RAG_DIR / "rag_vectors.sqlite3"

def rag_connection():
    connection = sqlite3.connect(RAG_DB_PATH)
    connection.execute("""CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_uid TEXT NOT NULL,
        source_name TEXT NOT NULL,
        chunk_text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        created_at TEXT NOT NULL
    )""")
    connection.commit()
    return connection

RAG_SEED = {
    "Python Interview Notes": "Python is a high-level, interpreted, dynamically typed programming language. OOP in Python includes classes, objects, encapsulation, inheritance, polymorphism and abstraction. A class is a blueprint; an object is an instance. Encapsulation groups data and methods. Inheritance reuses and extends a parent class. Polymorphism allows a common interface with different implementations. Abstraction exposes essential behavior while hiding implementation. Python lists are mutable, tuples are immutable, dictionaries store key-value pairs, and sets store unique values. List comprehensions provide concise list creation. Exceptions are handled with try, except, else and finally. A generator yields values lazily using yield.",
    "SQL and DBMS Interview Notes": "SQL is used to define, query and manipulate relational data. SELECT retrieves rows, WHERE filters rows, GROUP BY aggregates groups, HAVING filters groups, ORDER BY sorts results. INNER JOIN returns matching rows; LEFT JOIN preserves all left rows. Primary keys uniquely identify rows; foreign keys reference keys in another table. Normalization reduces redundancy: 1NF has atomic values, 2NF removes partial dependency, 3NF removes transitive dependency. Indexes can speed up reads but add storage and write overhead. ACID means atomicity, consistency, isolation and durability.",
    "Data Structures and Algorithms Notes": "An array stores indexed elements. A linked list stores nodes connected by references. A stack follows LIFO; a queue follows FIFO. A hash table maps keys to values and offers average constant-time lookup. A tree is hierarchical; a binary search tree orders smaller values left and larger values right. A graph contains vertices and edges. Linear search is O(n); binary search on sorted data is O(log n). Common sorting algorithms include merge sort O(n log n) and quicksort average O(n log n). Big-O describes growth of time or space as input size increases.",
    "Aptitude Preparation Notes": "For percentages, x percent of y equals x*y/100. Profit percentage is profit divided by cost price times 100. Speed equals distance divided by time. For time and work, if a person completes work in x days, one-day work is 1/x. Average equals sum of values divided by count. For simple interest, SI = P*R*T/100. For compound interest, amount = P(1+R/100)^T. In probability, probability equals favorable outcomes divided by total equally likely outcomes. Practice ratios, proportions, averages, time and work, speed-distance-time, permutations, combinations and data interpretation.",
    "HR Interview Preparation Notes": "Use the STAR structure for behavioral questions: Situation, Task, Action and Result. A self-introduction should briefly cover education, relevant skills, projects, achievements and career objective. For strengths, provide a genuine strength with evidence. For weaknesses, mention a real development area and steps being taken to improve. For conflict questions, explain listening, facts, respectful communication and resolution. For why this company, connect researched company work with your interests and skills. Be concise, specific and honest.",
    "Machine Learning Interview Notes": "Supervised learning uses labeled examples for classification or regression. Unsupervised learning finds structure in unlabeled data, such as clustering. Train, validation and test sets support model development and unbiased evaluation. Overfitting occurs when a model memorizes training data and generalizes poorly; regularization, cross-validation and simpler models can help. Classification metrics include precision, recall, F1-score and confusion matrix. Linear regression predicts continuous values; logistic regression is commonly used for classification. Decision trees split data using feature rules; random forests aggregate many trees. K-means groups data around centroids.",
}

def split_into_chunks(text: str, size: int = 850, overlap: int = 120):
    clean = " ".join(text.split())
    if not clean:
        return []
    chunks = []
    start = 0
    while start < len(clean):
        end = min(len(clean), start + size)
        if end < len(clean):
            boundary = clean.rfind(" ", start, end)
            if boundary > start + size // 2:
                end = boundary
        chunks.append(clean[start:end].strip())
        if end >= len(clean):
            break
        start = max(end - overlap, start + 1)
    return chunks

async def embed_text(text: str):
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="Add GEMINI_API_KEY to backend/.env to enable RAG embeddings.")
    embedding_model = os.getenv("GEMINI_EMBEDDING_MODEL", "gemini-embedding-001").strip()
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{embedding_model}:embedContent"
    payload = {"model": f"models/{embedding_model}", "content": {"parts": [{"text": text[:8000]}]}}
    try:
        async with httpx.AsyncClient(timeout=45.0) as client:
            response = await client.post(url, headers={"x-goog-api-key": api_key}, json=payload)
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"Gemini embedding error ({response.status_code}): {response.text[:500]}")
        values = response.json().get("embedding", {}).get("values", [])
        if not values:
            raise HTTPException(status_code=502, detail="Gemini returned an empty embedding.")
        return values
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Embedding service connection failed: {str(exc)[:300]}")

def cosine_similarity(a, b):
    if not a or len(a) != len(b):
        return 0.0
    dot = sum(x*y for x, y in zip(a, b))
    na = math.sqrt(sum(x*x for x in a)); nb = math.sqrt(sum(y*y for y in b))
    return dot / (na * nb) if na and nb else 0.0

async def ensure_seed_knowledge():
    connection = rag_connection()
    try:
        count = connection.execute("SELECT COUNT(*) FROM chunks WHERE owner_uid='__shared__'").fetchone()[0]
        if count:
            return
        for name, content in RAG_SEED.items():
            for chunk in split_into_chunks(content):
                vector = await embed_text(chunk)
                connection.execute("INSERT INTO chunks(owner_uid,source_name,chunk_text,embedding,created_at) VALUES(?,?,?,?,?)",
                    ("__shared__", name, chunk, json.dumps(vector), datetime.now(timezone.utc).isoformat()))
        connection.commit()
    finally:
        connection.close()

async def retrieve_context(uid: str, query: str, limit: int = 5):
    await ensure_seed_knowledge()
    query_vector = await embed_text(query)
    connection = rag_connection()
    try:
        rows = connection.execute("SELECT source_name,chunk_text,embedding FROM chunks WHERE owner_uid IN ('__shared__', ?)", (uid,)).fetchall()
    finally:
        connection.close()
    ranked = []
    for source_name, chunk_text, vector_json in rows:
        try:
            score = cosine_similarity(query_vector, json.loads(vector_json))
        except Exception:
            continue
        ranked.append((score, source_name, chunk_text))
    ranked.sort(key=lambda item: item[0], reverse=True)
    selected = [item for item in ranked[:limit] if item[0] > 0.20]
    context = "\n\n".join(f"[Source: {name}]\n{text}" for _, name, text in selected)
    sources = list(dict.fromkeys(name for _, name, _ in selected))
    return context, sources

async def ingest_document(uid: str, filename: str, content: bytes):
    suffix = Path(filename).suffix.lower()
    if suffix == ".pdf":
        try:
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(content))
            text = "\n".join(page.extract_text() or "" for page in reader.pages)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Could not read PDF: {str(exc)[:250]}")
    elif suffix == ".docx":
        try:
            from docx import Document
            document = Document(io.BytesIO(content))
            text = "\n".join(paragraph.text for paragraph in document.paragraphs)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Could not read DOCX: {str(exc)[:250]}")
    elif suffix in {".txt", ".md", ".csv"}:
        text = content.decode("utf-8", errors="ignore")
    else:
        raise HTTPException(status_code=400, detail="Supported files: PDF, DOCX, TXT, MD and CSV.")
    if len(text.strip()) < 30:
        raise HTTPException(status_code=400, detail="The uploaded file has too little extractable text. Scanned PDFs need OCR before upload.")
    chunks = split_into_chunks(text)
    if len(chunks) > 80:
        chunks = chunks[:80]
    connection = rag_connection()
    try:
        for chunk in chunks:
            vector = await embed_text(chunk)
            connection.execute("INSERT INTO chunks(owner_uid,source_name,chunk_text,embedding,created_at) VALUES(?,?,?,?,?)",
                (uid, filename[:240], chunk, json.dumps(vector), datetime.now(timezone.utc).isoformat()))
        connection.commit()
    finally:
        connection.close()
    return {"filename": filename, "chunks_indexed": len(chunks)}

# ==================================================
# REQUEST MODELS
# ==================================================

class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    history: list[dict] = Field(default_factory=list)


class MockRequest(BaseModel):
    interview_type: str = "Mixed"
    difficulty: str = "Medium"
    question_count: int = Field(default=5, ge=1, le=10)
    answers: list[str] = Field(default_factory=list)


class AptitudeAttempt(BaseModel):
    question_id: int
    selected_option: int


class StudentProfile(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    college: str = Field(default="", max_length=200)
    branch: str = Field(default="", max_length=120)
    year: str = Field(default="", max_length=40)


# ==================================================
# APTITUDE QUESTIONS
# ==================================================

QUESTIONS = [
    {
        "id": 1,
        "topic": "Quantitative Aptitude",
        "question": (
            "A number is increased by 20% and then "
            "decreased by 20%. What is the net change?"
        ),
        "options": [
            "No change",
            "4% decrease",
            "4% increase",
            "2% decrease"
        ],
        "answer": 1,
        "explanation": (
            "Let the number be 100. After a 20% increase, "
            "it becomes 120. After a 20% decrease, it "
            "becomes 96. Therefore, the net change is "
            "a 4% decrease."
        )
    },
    {
        "id": 2,
        "topic": "Logical Reasoning",
        "question": "Find the next number: 2, 6, 12, 20, 30, ?",
        "options": ["36", "40", "42", "44"],
        "answer": 2,
        "explanation": (
            "The differences are 4, 6, 8 and 10. "
            "The next difference is 12. Therefore, "
            "the answer is 42."
        )
    },
    {
        "id": 3,
        "topic": "Verbal Ability",
        "question": "Choose the grammatically correct sentence.",
        "options": [
            "She don't like coffee.",
            "She doesn't likes coffee.",
            "She doesn't like coffee.",
            "She not like coffee."
        ],
        "answer": 2,
        "explanation": (
            "Use doesn't followed by the base form "
            "of the verb: doesn't like."
        )
    }

    ,{
        "id": 4, "topic": "Quantitative Aptitude",
        "question": "A train travels 120 km in 2 hours. What is its average speed?",
        "options": ["40 km/h", "50 km/h", "60 km/h", "80 km/h"], "answer": 2,
        "explanation": "Average speed = distance / time = 120 / 2 = 60 km/h."
    },
    {
        "id": 5, "topic": "Quantitative Aptitude",
        "question": "What is 25% of 360?",
        "options": ["80", "90", "100", "120"], "answer": 1,
        "explanation": "25% is one-fourth. 360 / 4 = 90."
    },
    {
        "id": 6, "topic": "Logical Reasoning",
        "question": "Find the odd one out: 9, 16, 25, 36, 49, 55.",
        "options": ["16", "25", "49", "55"], "answer": 3,
        "explanation": "16, 25 and 49 are perfect squares, as are 9 and 36; 55 is not a perfect square."
    },
    {
        "id": 7, "topic": "Logical Reasoning",
        "question": "If CAT is coded as DBU, how is DOG coded?",
        "options": ["EPH", "EOG", "CNG", "FPI"], "answer": 0,
        "explanation": "Each letter is shifted one position forward: D→E, O→P, G→H."
    },
    {
        "id": 8, "topic": "Verbal Ability",
        "question": "Choose the synonym of 'abundant'.",
        "options": ["Rare", "Plentiful", "Tiny", "Empty"], "answer": 1,
        "explanation": "Abundant means available in large quantities; plentiful is a synonym."
    },
    {
        "id": 9, "topic": "Verbal Ability",
        "question": "Choose the correct word: She has been working here ___ 2022.",
        "options": ["for", "from", "since", "during"], "answer": 2,
        "explanation": "Use 'since' with a specific starting point in time."
    },
    {
        "id": 10, "topic": "Quantitative Aptitude",
        "question": "The ratio of 20 to 35 in simplest form is:",
        "options": ["2:5", "4:7", "5:7", "7:4"], "answer": 1,
        "explanation": "Divide both terms by 5: 20:35 = 4:7."
    },
    {
        "id": 11, "topic": "Logical Reasoning",
        "question": "Complete the series: 3, 6, 12, 24, __.",
        "options": ["36", "42", "48", "54"], "answer": 2,
        "explanation": "Each term is multiplied by 2, so 24 × 2 = 48."
    },
    {
        "id": 12, "topic": "Quantitative Aptitude",
        "question": "A product costs ₹800 after a 20% discount. What was its marked price?",
        "options": ["₹900", "₹960", "₹1,000", "₹1,200"], "answer": 2,
        "explanation": "₹800 is 80% of the marked price. Marked price = 800 / 0.8 = ₹1,000."
    }

]


# ==================================================
# TECHNICAL AND HR TOPICS
# ==================================================

TOPICS = {
    "technical": [
        "Python",
        "Java",
        "SQL",
        "DBMS",
        "Object-Oriented Programming",
        "Operating Systems",
        "Computer Networks",
        "Data Structures and Algorithms",
        "Artificial Intelligence",
        "Machine Learning"
    ],
    "hr": [
        "Tell me about yourself",
        "Strengths and weaknesses",
        "Why should we hire you?",
        "Career goals",
        "Teamwork and conflict resolution",
        "Leadership and ownership"
    ]
}


# ==================================================
# ACTIVITY HELPER
# ==================================================

def add_activity(progress: dict, label: str):

    progress["recent_activity"].append({
        "label": label,
        "time": datetime.now(timezone.utc).isoformat()
    })


# ==================================================
# GEMINI AI INTEGRATION
# ==================================================

async def ask_gemini(prompt: str) -> str:

    api_key = os.getenv("GEMINI_API_KEY")

    model = os.getenv(
        "GEMINI_MODEL",
        "gemini-3.1-flash-lite"
    ).strip()

    if not api_key:
        raise HTTPException(
            status_code=503,
            detail=(
                "Gemini API key is missing. "
                "Add GEMINI_API_KEY to backend/.env "
                "and restart the backend."
            )
        )

    url = (
        "https://generativelanguage.googleapis.com/"
        f"v1beta/models/{model}:generateContent"
    )

    headers = {
        "x-goog-api-key": api_key,
        "Content-Type": "application/json"
    }

    payload = {
        "contents": [
            {
                "parts": [
                    {"text": prompt}
                ]
            }
        ],
        "generationConfig": {
            "temperature": 0.5,
            "maxOutputTokens": 1200
        }
    }

    timeout = httpx.Timeout(
        90.0,
        connect=20.0
    )

    try:
        print(f"Gemini request started. Model: {model}")

        async with httpx.AsyncClient(
            timeout=timeout
        ) as client:

            response = await client.post(
                url,
                headers=headers,
                json=payload
            )

        print(f"Gemini HTTP status: {response.status_code}")

        if response.status_code >= 400:

            error_details = response.text[:1500]

            print("Gemini API error response:")
            print(error_details)

            raise HTTPException(
                status_code=response.status_code,
                detail=(
                    f"Gemini API returned HTTP "
                    f"{response.status_code}: {error_details}"
                )
            )

        data = response.json()
        candidates = data.get("candidates", [])

        if not candidates:
            raise HTTPException(
                status_code=502,
                detail="Gemini returned no answer."
            )

        parts = candidates[0].get(
            "content", {}
        ).get("parts", [])

        answer = "\n".join(
            part.get("text", "")
            for part in parts
            if part.get("text")
        ).strip()

        if not answer:
            raise HTTPException(
                status_code=502,
                detail="Gemini returned an empty response."
            )

        print("Gemini response received successfully.")
        return answer

    except HTTPException:
        raise

    except httpx.TimeoutException as error:
        raise HTTPException(
            status_code=504,
            detail=f"Gemini request timed out: {str(error)[:300]}"
        )

    except httpx.HTTPError as error:
        raise HTTPException(
            status_code=502,
            detail=f"Gemini connection failed: {str(error)[:500]}"
        )

    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Unexpected AI error: {str(error)[:500]}"
        )
        # ==================================================
# ROOT ENDPOINT
# ==================================================

@app.get("/")
def root():
    return {
        "message": "Placement Prep Interview Coach API",
        "version": "1.1.0",
        "docs": "/docs"
    }


# ==================================================
# HEALTH CHECK
# ==================================================

@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "database": (
            "mongodb" if db is not None else "demo-memory"
        ),
        "gemini_configured": bool(GEMINI_API_KEY),
        "gemini_model": GEMINI_MODEL,
        "firebase_configured": True
    }


# ==================================================
# DASHBOARD
# ==================================================

@app.get("/api/dashboard")
def dashboard(request: Request):

    progress = get_user_progress(request)

    attempts = progress["aptitude_attempts"]
    correct = progress["aptitude_correct"]

    accuracy = (
        round(correct / attempts * 100)
        if attempts > 0 else 0
    )

    readiness_score = min(
        100,
        25
        + correct * 8
        + progress["mock_interviews"] * 5
    )

    return {
        "readiness_score": readiness_score,
        "aptitude_attempts": attempts,
        "aptitude_accuracy": accuracy,
        "mock_interviews": progress["mock_interviews"],
        "recent_activity": (
            progress["recent_activity"][-5:][::-1]
        ),
        "modules": [
            {
                "name": "Aptitude",
                "progress": min(100, attempts * 12)
            },
            {
                "name": "Coding",
                "progress": 15
            },
            {
                "name": "Technical",
                "progress": 20
            },
            {
                "name": "HR",
                "progress": 10
            }
        ]
    }


# ==================================================
# APTITUDE QUESTIONS
# ==================================================

@app.get("/api/aptitude/questions")
def aptitude_questions():

    return [
        {
            key: value
            for key, value in question.items()
            if key not in ("answer", "explanation")
        }
        for question in QUESTIONS
    ]


# ==================================================
# SUBMIT APTITUDE ANSWER
# ==================================================

@app.post("/api/aptitude/submit")
def submit_aptitude(
    attempt: AptitudeAttempt,
    request: Request
):

    question = next(
        (
            item for item in QUESTIONS
            if item["id"] == attempt.question_id
        ),
        None
    )

    if question is None:
        raise HTTPException(
            status_code=404,
            detail="Question not found."
        )

    if not 0 <= attempt.selected_option < len(
        question["options"]
    ):
        raise HTTPException(
            status_code=400,
            detail="Invalid selected option."
        )

    is_correct = (
        attempt.selected_option == question["answer"]
    )

    progress = get_user_progress(request)

    progress["aptitude_attempts"] += 1
    progress["aptitude_correct"] += int(is_correct)

    add_activity(
        progress,
        f"Attempted {question['topic']}"
    )
    save_user_progress(request, progress)

    return {
        "correct": is_correct,
        "correct_option": question["answer"],
        "explanation": question["explanation"]
    }


# ==================================================
# TECHNICAL AND HR TOPICS
# ==================================================

@app.get("/api/topics")
def topics():
    return TOPICS


# ==================================================
# CODING PRACTICE QUESTIONS
# ==================================================

@app.get("/api/coding/questions")
def coding_questions():
    return [
        {"title": "Reverse a String", "language": "Python", "difficulty": "Easy", "description": "Return a reversed version of the given string without using a built-in reverse function.", "example": "Input: hello\nOutput: olleh"},
        {"title": "Find the Second Largest", "language": "Python", "difficulty": "Easy", "description": "Find the second largest distinct number in a list. Handle duplicates and lists with fewer than two distinct values.", "example": "Input: [4, 1, 7, 7, 3]\nOutput: 4"},
        {"title": "Two Sum", "language": "Python", "difficulty": "Easy", "description": "Return the indices of two numbers that add up to a target. Assume exactly one solution exists.", "example": "Input: nums=[2, 7, 11, 15], target=9\nOutput: [0, 1]"},
        {"title": "Palindrome Check", "language": "Python", "difficulty": "Easy", "description": "Check whether a string is a palindrome. Explain how you handle spaces and letter case.", "example": "Input: 'Madam'\nOutput: True (case-insensitive)"},
        {"title": "Character Frequency", "language": "Python", "difficulty": "Easy", "description": "Count the frequency of each character in a string and return a mapping.", "example": "Input: banana\nOutput: {'b': 1, 'a': 3, 'n': 2}"},
        {"title": "FizzBuzz", "language": "Python", "difficulty": "Easy", "description": "For numbers 1 through n, print Fizz for multiples of 3, Buzz for multiples of 5, and FizzBuzz for both.", "example": "Input: n=5\nOutput: 1, 2, Fizz, 4, Buzz"},
        {"title": "SQL: Department Counts", "language": "SQL", "difficulty": "Medium", "description": "Write a query to count employees in each department and show the department id with the count.", "example": "SELECT department_id, COUNT(*) FROM employees GROUP BY department_id;"},
        {"title": "Remove Duplicates", "language": "Python", "difficulty": "Medium", "description": "Return a list with duplicate values removed while preserving the original order.", "example": "Input: [1, 2, 1, 3, 2]\nOutput: [1, 2, 3]"}
    ]


# ==================================================
# RAG DOCUMENT MANAGEMENT
# ==================================================

@app.post("/api/rag/upload")
async def upload_rag_document(request: Request, file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(status_code=400, detail="Choose a document first.")
    content = await file.read()
    if len(content) > 12 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Maximum upload size is 12 MB.")
    result = await ingest_document(request.state.firebase_user["uid"], file.filename, content)
    return {"message": "Document indexed successfully.", **result}

@app.get("/api/rag/documents")
def list_rag_documents(request: Request):
    uid = request.state.firebase_user["uid"]
    connection = rag_connection()
    try:
        rows = connection.execute("SELECT source_name, COUNT(*) FROM chunks WHERE owner_uid=? GROUP BY source_name ORDER BY source_name", (uid,)).fetchall()
    finally:
        connection.close()
    return {"documents": [{"filename": name, "chunks": count} for name, count in rows]}

@app.delete("/api/rag/documents/{filename}")
def delete_rag_document(filename: str, request: Request):
    connection = rag_connection()
    try:
        cursor = connection.execute("DELETE FROM chunks WHERE owner_uid=? AND source_name=?", (request.state.firebase_user["uid"], filename))
        connection.commit()
        return {"deleted_chunks": cursor.rowcount, "filename": filename}
    finally:
        connection.close()

# ==================================================
# AI CHATBOT
# ==================================================

@app.post("/api/ai/chat")
async def chat(request: ChatRequest, http_request: Request):
    uid = http_request.state.firebase_user["uid"]
    context, sources = await retrieve_context(uid, request.message)
    history_text = "\n".join(
        f"{item.get('role', 'user')}: {str(item.get('text', ''))[:1500]}"
        for item in request.history[-8:]
    )
    prompt = (
        "You are PrepPilot, a placement preparation mentor using retrieval-augmented generation. "
        "Answer the student's question using the retrieved context when relevant. "
        "Do not invent citations or claim that information came from a source not listed. "
        "If the retrieved context is insufficient, say so clearly and then provide general knowledge separately. "
        "Explain concepts simply, include examples and interview-focused takeaways.\n\n"
        f"Retrieved knowledge context:\n{context or 'No sufficiently similar knowledge chunks were retrieved.'}\n\n"
        f"Conversation history:\n{history_text}\n\nStudent question:\n{request.message}"
    )
    answer = await ask_gemini(prompt)
    return {"answer": answer, "rag_used": bool(context), "sources": sources}


# ==================================================
# AI MOCK INTERVIEW
# ==================================================

@app.post("/api/ai/mock-interview")
async def mock_interview(
    request: MockRequest,
    http_request: Request
):

    progress = get_user_progress(http_request)
    answer_hint = " ".join(request.answers)[:2500] if request.answers else ""
    rag_query = f"{request.interview_type} placement interview {request.difficulty} questions and evaluation guidance {answer_hint}"
    context, sources = await retrieve_context(http_request.state.firebase_user["uid"], rag_query)

    if not request.answers:

        prompt = (
            f"Create {request.question_count} concise "
            f"{request.difficulty} level "
            f"{request.interview_type} placement interview questions.\n\n"

            "Instructions:\n"
            "- Number each question.\n"
            "- Make questions suitable for fresh graduates.\n"
            "- Keep questions clear and relevant.\n"
            "- Do not provide answers.\n\n"
            f"Use this retrieved preparation context where relevant:\n{context}"
        )

        questions = await ask_gemini(prompt)

        return {
            "questions": questions, "rag_used": bool(context), "sources": sources
        }

    cleaned_answers = [
        answer.strip()[:4000]
        for answer in request.answers
        if answer.strip()
    ]

    if not cleaned_answers:
        raise HTTPException(
            status_code=400,
            detail="Please provide at least one answer."
        )

    prompt = (
        f"Evaluate these {request.interview_type} "
        f"interview answers at {request.difficulty} level.\n\n"

        "Evaluate using these criteria:\n"
        "1. Relevance\n"
        "2. Technical correctness\n"
        "3. Clarity\n"
        "4. Completeness\n"
        "5. Communication quality\n\n"

        "Provide:\n"
        "- Overall score out of 10.\n"
        "- Individual feedback for each answer.\n"
        "- Strengths.\n"
        "- Areas for improvement.\n"
        "- A suggested improved answer.\n\n"

        "Be constructive and supportive. "
        "Do not give an unnecessarily high score.\n\n"

        f"Retrieved preparation context:\n{context}\n\n"
        "Student answers:\n"
        + "\n".join(
            f"{index + 1}. {answer}"
            for index, answer in enumerate(cleaned_answers)
        )
    )

    feedback = await ask_gemini(prompt)

    progress["mock_interviews"] += 1

    add_activity(
        progress,
        "Completed a mock interview review"
    )
    save_user_progress(http_request, progress)

    return {
        "feedback": feedback, "rag_used": bool(context), "sources": sources
    }


# ==================================================
# STUDENT PROFILE
# ==================================================

@app.get("/api/profile")
def profile(request: Request):
    user = request.state.firebase_user
    uid = user["uid"]
    saved = demo_profiles_by_user.get(uid, {})
    if db is not None:
        saved = db.student_profiles.find_one({"_id": uid}) or saved
    return {
        "name": saved.get("name") or user.get("name") or user.get("email", "Student"),
        "email": user.get("email"),
        "email_verified": user.get("email_verified", False),
        "college": saved.get("college", ""),
        "branch": saved.get("branch", ""),
        "year": saved.get("year", ""),
        "goal": "Become placement-ready"
    }


@app.post("/api/profile")
def save_profile(profile_data: StudentProfile, request: Request):
    uid = request.state.firebase_user["uid"]
    payload = profile_data.model_dump()
    demo_profiles_by_user[uid] = payload
    if db is not None:
        db.student_profiles.update_one({"_id": uid}, {"$set": payload}, upsert=True)
    return {"message": "Profile saved", **payload}


# APPLICATION STARTUP
# ==================================================

@app.on_event("startup")
async def startup_event():

    print("--------------------------------------")
    print("Placement Prep Interview Coach API")
    print("Backend started successfully.")
    print(f"Gemini model: {GEMINI_MODEL}")
    print(f"Gemini configured: {bool(GEMINI_API_KEY)}")
    print("Firebase authentication: enabled")
    print(f"MongoDB connected: {db is not None}")
    print("--------------------------------------")


# ==================================================
# APPLICATION SHUTDOWN
# ==================================================

@app.on_event("shutdown")
async def shutdown_event():

    if mongo_client is not None:
        mongo_client.close()

    print("Backend stopped.")