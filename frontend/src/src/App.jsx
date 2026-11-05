
import React, { useEffect, useState } from 'react';
import { auth } from './firebase';
import {
  LayoutDashboard, Brain, Code2, BookOpen, MessageCircle,
  Mic2, TrendingUp, Search, Bell, Sparkles, ArrowUpRight,
  ChevronRight, Menu, X, Send, Target, Flame, Trophy, Clock3,
  CheckCircle2, CircleHelp, LoaderCircle
} from 'lucide-react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const nav = [
  ['Overview', LayoutDashboard],
  ['Aptitude', Brain],
  ['Coding Lab', Code2],
  ['Technical Prep', BookOpen],
  ['HR Prep', MessageCircle],
  ['AI Mentor', Sparkles],
  ['Mock Interview', Mic2],
  ['Progress', TrendingUp]
];

async function api(path, options = {}) {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Please sign in to continue.');
  }

  const token = await currentUser.getIdToken();

  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
      Authorization: `Bearer ${token}`
    }
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.detail || 'Request failed');
  }

  return data;
}

function App() {
  const [page, setPage] = useState('Overview');
  const [mobile, setMobile] = useState(false);

  const [dash, setDash] = useState(null);
  const [profile, setProfile] = useState({});
  const [questions, setQuestions] = useState([]);
  const [codingQuestions, setCodingQuestions] = useState([]);
  const [codingIndex, setCodingIndex] = useState(0);
  const [codingLanguage, setCodingLanguage] = useState('Python');
  const [codingAnswer, setCodingAnswer] = useState('');
  const [codingReview, setCodingReview] = useState('');
  const [topics, setTopics] = useState({
    technical: [],
    hr: []
  });

  const [questionIndex, setQuestionIndex] = useState(0);
  const [selected, setSelected] = useState(null);
  const [feedback, setFeedback] = useState('');

  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      text: 'Hi! I’m your AI placement mentor. Ask me about Python, SQL, aptitude, coding or interview preparation.'
    }
  ]);

  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [mockType, setMockType] = useState('Mixed');
  const [mockQuestions, setMockQuestions] = useState('');
  const [answers, setAnswers] = useState('');
  const [mockFeedback, setMockFeedback] = useState('');
  const [mockSources, setMockSources] = useState([]);
  const [error, setError] = useState('');
  const [selectedResource, setSelectedResource] = useState(null);
  const [ragDocs, setRagDocs] = useState([]);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [ragNotice, setRagNotice] = useState('');
  const studentEmail = auth.currentUser?.email || '';
  const savedProfile = studentEmail ? (() => { try { return JSON.parse(localStorage.getItem(`preppilot-profile-${studentEmail.toLowerCase()}`) || '{}'); } catch { return {}; } })() : {};
  const studentName = auth.currentUser?.displayName || savedProfile.name || studentEmail.split('@')[0] || 'Student';
  const studentCollege = savedProfile.college || 'College not added';
  const studentBranch = savedProfile.branch || 'Branch not added';
  const studentYear = savedProfile.year || 'Year not added';

  async function refresh() {
    try {
      setDash(await api('/api/dashboard'));
      setProfile(await api('/api/profile'));
      setQuestions(await api('/api/aptitude/questions'));
      setCodingQuestions(await api('/api/coding/questions'));
      setTopics(await api('/api/topics'));
      const rag = await api('/api/rag/documents');
      setRagDocs(rag.documents || []);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function go(p) {
    setPage(p);
    setMobile(false);
    setError('');
    setFeedback('');
  }

  async function submitAnswer() {
    if (selected === null || !questions[questionIndex]) return;

    try {
      const r = await api('/api/aptitude/submit', {
        method: 'POST',
        body: JSON.stringify({
          question_id: questions[questionIndex].id,
          selected_option: selected
        })
      });

      setFeedback(
        `${r.correct ? 'Correct!' : 'Not quite.'} ${r.explanation}`
      );

      refresh();
    } catch (e) {
      setError(e.message);
    }
  }

  async function reviewCodingSolution() {
    if (!codingAnswer.trim() || !codingQuestions[codingIndex] || busy) return;
    setBusy(true);
    setCodingReview('');
    setError('');
    const challenge = codingQuestions[codingIndex];
    try {
      const r = await api('/api/ai/chat', {
        method: 'POST',
        body: JSON.stringify({
          message: `Review my ${codingLanguage} solution for this coding challenge. Challenge: ${challenge.title}. Description: ${challenge.description}. Example: ${challenge.example || 'Not provided'}. My code:
${codingAnswer}
Please check logic, edge cases, time complexity, and suggest corrections. Do not claim that the code was executed.`,
          history: []
        })
      });
      setCodingReview(r.answer || 'No review was returned.');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function sendChat() {
    if (!input.trim() || busy) return;

    const msg = input.trim();

    const next = [
      ...messages,
      { role: 'user', text: msg }
    ];

    setMessages(next);
    setInput('');
    setBusy(true);
    setError('');

    try {
      const r = await api('/api/ai/chat', {
        method: 'POST',
        body: JSON.stringify({
          message: msg,
          history: messages.slice(-8)
        })
      });

      const sourceNote = r.sources?.length ? `\n\nSources retrieved: ${r.sources.join(', ')}` : '\n\nNo matching uploaded/knowledge-base sources were retrieved; answer may use general model knowledge.';
      setMessages([
        ...next,
        { role: 'assistant', text: r.answer + sourceNote }
      ]);
    } catch (e) {
      setError(e.message);

      setMessages([
        ...next,
        {
          role: 'assistant',
          text: 'I could not reach the AI service. Check that the backend is running and GEMINI_API_KEY is configured.'
        }
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function uploadKnowledgeFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploadingDoc(true);
    setRagNotice('');
    try {
      const token = await auth.currentUser.getIdToken();
      const form = new FormData();
      form.append('file', file);
      const response = await fetch(`${API}/api/rag/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || 'Document upload failed');
      setRagNotice(`${data.filename}: ${data.chunks_indexed} chunks indexed successfully.`);
      const docs = await api('/api/rag/documents');
      setRagDocs(docs.documents || []);
    } catch (e) {
      setRagNotice(e.message);
    } finally {
      setUploadingDoc(false);
      event.target.value = '';
    }
  }

  async function startMock() {
    setBusy(true);
    setError('');
    setMockFeedback('');

    try {
      const r = await api('/api/ai/mock-interview', {
        method: 'POST',
        body: JSON.stringify({
          interview_type: mockType,
          difficulty: 'Medium',
          question_count: 5
        })
      });

      setMockQuestions(r.questions);
      setMockSources(r.sources || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function reviewMock() {
    setBusy(true);

    try {
      const r = await api('/api/ai/mock-interview', {
        method: 'POST',
        body: JSON.stringify({
          interview_type: mockType,
          difficulty: 'Medium',
          question_count: 5,
          answers: answers.split('\n').filter(Boolean)
        })
      });

      setMockFeedback(r.feedback);
      setMockSources(r.sources || []);
      refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const current = questions[questionIndex];

  return (
    <div className="app-shell">

      <aside className={`sidebar ${mobile ? 'mobile-open' : ''}`}>
        <div className="brand">
          <div className="brand-mark">
            <Sparkles size={20} />
          </div>

          <div>
            <b>PrepPilot</b>
            <small>PLACEMENT COACH</small>
          </div>

          <button
            className="mobile-close"
            onClick={() => setMobile(false)}
          >
            <X />
          </button>
        </div>

        <div className="workspace-label">WORKSPACE</div>

        <nav>
          {nav.map(([label, Icon]) => (
            <button
              key={label}
              onClick={() => go(label)}
              className={`nav-item ${page === label ? 'active' : ''}`}
            >
              <Icon size={18} />
              <span>{label}</span>
              {label === 'AI Mentor' && <i className="live-dot" />}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="upgrade-card">
            <div className="upgrade-icon">
              <Trophy size={18} />
            </div>

            <b>Your next offer starts here.</b>
            <p>Small daily progress builds placement confidence.</p>

            <button onClick={() => go('Progress')}>
              View progress <ArrowUpRight size={14} />
            </button>
          </div>

          <div className="profile-mini">
            <div className="avatar">{studentName.charAt(0).toUpperCase()}</div>
            <div>
              <b>Student Workspace</b>
              <small>CSE · AIML</small>
            </div>
            <span className="online-dot" />
          </div>
        </div>
      </aside>

      <main className="main">

        <header className="topbar">
          <button
            className="mobile-menu"
            onClick={() => setMobile(true)}
          >
            <Menu />
          </button>

          <div className="breadcrumb">
            Workspace <ChevronRight size={14} /> <b>{page}</b>
          </div>

          <div className="top-actions">
            <div className="searchbox">
              <Search size={16} />
              <input placeholder="Search topics, skills..." />
            </div>

            <button className="icon-button">
              <Bell size={18} />
              <i />
            </button>

            <div className="avatar small-avatar" title={studentEmail}>{studentName.charAt(0).toUpperCase()}</div>
          </div>
        </header>

        <div className="content">

          {error && (
            <div className="alert">
              <CircleHelp size={17} />
              {error}
              <button onClick={() => setError('')}>Dismiss</button>
            </div>
          )}

          {/* OVERVIEW */}

          {page === 'Overview' && (
            <>
              <div className="welcome-row">
                <div>
                  <div className="eyebrow">
                    <Sparkles size={14} /> YOUR PERSONAL PLACEMENT SPACE
                  </div>

                  <h1>
                    Let’s make you <span>placement ready.</span>
                  </h1>

                  <p>
                    Your preparation journey, organized in one place.
                    Keep showing up — progress follows.
                  </p>
                </div>

                <div className="date-pill">
                  <span className="pulse" />
                  YOUR JOURNEY, YOUR PACE
                </div>
              </div>

              <div className="hero-card">
                <div className="hero-copy">
                  <div className="hero-kicker">THIS WEEK’S FOCUS</div>

                  <h2>
                    Build skills.<br />
                    <em>Build confidence.</em>
                  </h2>

                  <p>
                    Practice a little every day and turn preparation
                    into progress.
                  </p>

                  <button
                    className="primary-btn"
                    onClick={() => go('Aptitude')}
                  >
                    Start practicing <ArrowUpRight size={16} />
                  </button>
                </div>

                <div className="hero-art">
                  <div className="orbit orbit-one" />
                  <div className="orbit orbit-two" />

                  <div className="hero-center">
                    <Target size={42} />
                  </div>

                  <div className="float-card float-top">
                    <Flame size={15} /> Daily focus
                  </div>

                  <div className="float-card float-bottom">
                    <Trophy size={15} /> Your next milestone
                  </div>
                </div>

                <div className="hero-glow" />
              </div>

              <div className="section-heading">
                <div>
                  <h3>Your preparation snapshot</h3>
                  <p>A quick look at where you are today.</p>
                </div>

                <button
                  className="text-btn"
                  onClick={() => go('Progress')}
                >
                  Full report <ArrowUpRight size={15} />
                </button>
              </div>

              <div className="stats-grid">
                <Stat
                  icon={Target}
                  label="Readiness score"
                  value={`${dash?.readiness_score ?? 25}%`}
                  note="Build it step by step"
                  color="violet"
                />

                <Stat
                  icon={Brain}
                  label="Aptitude attempts"
                  value={dash?.aptitude_attempts ?? 0}
                  note={`${dash?.aptitude_accuracy ?? 0}% accuracy`}
                  color="blue"
                />

                <Stat
                  icon={Mic2}
                  label="Mock interviews"
                  value={dash?.mock_interviews ?? 0}
                  note="Practice makes progress"
                  color="orange"
                />

                <Stat
                  icon={Flame}
                  label="Daily momentum"
                  value="Start today"
                  note="One focused session counts"
                  color="pink"
                />
              </div>

              <div className="two-col">
                <div className="panel">
                  <div className="panel-head">
                    <div>
                      <h3>Your learning path</h3>
                      <p>Four pillars of placement preparation</p>
                    </div>

                    <button className="dots">•••</button>
                  </div>

                  {(
                    dash?.modules || [
                      { name: 'Aptitude', progress: 0 },
                      { name: 'Coding', progress: 0 },
                      { name: 'Technical', progress: 0 },
                      { name: 'HR', progress: 0 }
                    ]
                  ).map((m, i) => (
                    <div className="progress-line" key={m.name}>
                      <div className="progress-title">
                        <span>{m.name}</span>
                        <b>{m.progress}%</b>
                      </div>

                      <div className="track">
                        <div
                          style={{ width: `${m.progress}%` }}
                          className={`fill fill-${i}`}
                        />
                      </div>
                    </div>
                  ))}
                </div>

                <div className="panel daily-panel">
                  <div className="daily-icon">
                    <Flame size={20} />
                  </div>

                  <div className="eyebrow">DAILY CHALLENGE</div>
                  <h3>Make today count.</h3>

                  <p>
                    Try one aptitude question or ask your AI mentor
                    to explain a concept you find difficult.
                  </p>

                  <button
                    className="secondary-btn"
                    onClick={() => go('AI Mentor')}
                  >
                    Meet your AI mentor <ChevronRight size={16} />
                  </button>
                </div>
              </div>

              <div className="section-heading">
                <div>
                  <h3>Jump back in</h3>
                  <p>Choose what you want to work on next.</p>
                </div>
              </div>

              <div className="feature-grid">
                <Feature
                  icon={Brain}
                  title="Aptitude arena"
                  desc="Sharpen speed, accuracy and reasoning."
                  onClick={() => go('Aptitude')}
                  tone="purple"
                />

                <Feature
                  icon={Code2}
                  title="Coding lab"
                  desc="Practice programming one problem at a time."
                  onClick={() => go('Coding Lab')}
                  tone="cyan"
                />

                <Feature
                  icon={Sparkles}
                  title="AI mentor"
                  desc="Get clear explanations whenever you need."
                  onClick={() => go('AI Mentor')}
                  tone="amber"
                />

                <Feature
                  icon={Mic2}
                  title="Mock interview"
                  desc="Practice answering with structured feedback."
                  onClick={() => go('Mock Interview')}
                  tone="rose"
                />
              </div>
            </>
          )}

          {/* APTITUDE */}

          {page === 'Aptitude' && (
            <>
              <PageIntro
                kicker="THINK SHARPER"
                title="Aptitude arena"
                desc="Practice reasoning, quantitative and verbal questions. Learn from every answer."
              />

              <div className="panel question-panel">
                {current ? (
                  <>
                    <div className="question-meta">
                      <span className="tag">{current.topic}</span>
                      <span>
                        Question {questionIndex + 1} of {questions.length}
                      </span>
                    </div>

                    <h2>{current.question}</h2>

                    <div className="options">
                      {current.options.map((o, i) => (
                        <button
                          key={o}
                          className={`option ${selected === i ? 'chosen' : ''}`}
                          onClick={() => {
                            setSelected(i);
                            setFeedback('');
                          }}
                        >
                          <span>{String.fromCharCode(65 + i)}</span>
                          {o}
                        </button>
                      ))}
                    </div>

                    {feedback && (
                      <div className="feedback">
                        <CheckCircle2 size={18} />
                        {feedback}
                      </div>
                    )}

                    <div className="question-actions">
                      <button
                        className="secondary-btn"
                        onClick={() => {
                          setQuestionIndex(
                            (questionIndex + 1) % Math.max(questions.length, 1)
                          );
                          setSelected(null);
                          setFeedback('');
                        }}
                      >
                        Next question <ChevronRight size={16} />
                      </button>

                      <button
                        className="primary-btn"
                        disabled={selected === null}
                        onClick={submitAnswer}
                      >
                        Check answer
                      </button>
                    </div>
                  </>
                ) : (
                  <p>Loading questions…</p>
                )}
              </div>
            </>
          )}

          {/* CODING LAB */}

          {page === 'Coding Lab' && (
            <>
              <PageIntro
                kicker="PRACTICE BY DOING"
                title="Coding lab"
                desc="Choose a challenge, write your solution and receive AI feedback on logic and complexity. Code is reviewed, not executed on the server."
              />
              <div className="panel question-panel" style={{ maxWidth: 900 }}>
                {codingQuestions.length ? (
                  <>
                    <div className="question-meta">
                      <span className="tag">{codingQuestions[codingIndex]?.difficulty || 'Practice'} · {codingQuestions[codingIndex]?.language || 'Python'}</span>
                      <span>Challenge {codingIndex + 1} of {codingQuestions.length}</span>
                    </div>
                    <h2>{codingQuestions[codingIndex]?.title}</h2>
                    <p className="muted">{codingQuestions[codingIndex]?.description}</p>
                    {codingQuestions[codingIndex]?.example && (
                      <pre className="generated">{codingQuestions[codingIndex].example}</pre>
                    )}
                    <label className="muted" htmlFor="coding-language">Programming language</label>
                    <select id="coding-language" value={codingLanguage} onChange={e => setCodingLanguage(e.target.value)} style={{ display: 'block', margin: '8px 0 14px', padding: 10, borderRadius: 8, background: '#0c1325', color: '#eef1ff', border: '1px solid #2a3552' }}>
                      <option>Python</option><option>Java</option><option>C</option><option>C++</option><option>JavaScript</option><option>SQL</option>
                    </select>
                    <textarea rows="12" value={codingAnswer} onChange={e => setCodingAnswer(e.target.value)} placeholder="Write your solution here..." style={{ fontFamily: 'Consolas, monospace', fontSize: 12, resize: 'vertical' }} />
                    <div className="question-actions">
                      <button className="secondary-btn" onClick={() => { setCodingIndex((codingIndex + codingQuestions.length - 1) % codingQuestions.length); setCodingReview(''); setCodingAnswer(''); }}>Previous</button>
                      <button className="secondary-btn" onClick={() => { setCodingIndex((codingIndex + 1) % codingQuestions.length); setCodingReview(''); setCodingAnswer(''); }}>Next challenge <ChevronRight size={16} /></button>
                      <button className="primary-btn" disabled={!codingAnswer.trim() || busy} onClick={reviewCodingSolution}>{busy ? 'Reviewing…' : 'Review my solution'} <Sparkles size={15} /></button>
                    </div>
                    {codingReview && <div className="feedback-block"><b>AI code review</b><pre>{codingReview}</pre></div>}
                  </>
                ) : <p>Loading coding challenges… If this remains empty, check the backend connection.</p>}
              </div>
              <div className="note">Safety note: PrepPilot reviews your submitted code with AI. It does not execute code or verify runtime output.</div>
            </>
          )}

          {/* TECHNICAL PREP */}

          {page === 'Technical Prep' && (
            <>
              <PageIntro
                kicker="KNOW YOUR FUNDAMENTALS"
                title="Technical preparation"
                desc="Revise the concepts that frequently appear in technical interviews."
              />

              <div className="topic-grid">
                {topics.technical.map((t, i) => (
                  <button type="button" className="topic-card" key={t} onClick={() => setSelectedResource({ title: t, category: "Technical topic", description: `Review the core concepts of ${t}, understand definitions, practical applications and common interview questions.`, kind: "topic" })}>
                    <div className="topic-number">
                      {String(i + 1).padStart(2, '0')}
                    </div>

                    <div>
                      <b>{t}</b>
                      <small>Concepts · Interview questions</small>
                    </div>

                    <ChevronRight size={17} />
                  </button>
                ))}
              </div>
            </>
          )}

          {/* HR PREP */}

          {page === 'HR Prep' && (
            <>
              <PageIntro
                kicker="TELL YOUR STORY"
                title="HR interview preparation"
                desc="Practice communicating your experiences, strengths and goals with confidence."
              />

              <div className="topic-grid">
                {topics.hr.map((t, i) => (
                  <button type="button" className="topic-card" key={t} onClick={() => setSelectedResource({ title: t, category: "HR interview practice", description: `Prepare a clear, genuine response to “${t}”. Structure your answer with a brief context, your action or reasoning, and a specific outcome.`, kind: "hr" })}>
                    <div className="topic-number">
                      {String(i + 1).padStart(2, '0')}
                    </div>

                    <div>
                      <b>{t}</b>
                      <small>Practice prompt · Sample response guidance</small>
                    </div>

                    <ChevronRight size={17} />
                  </button>
                ))}
              </div>
            </>
          )}

          {/* AI MENTOR */}

          {page === 'AI Mentor' && (
            <>
              <PageIntro
                kicker="YOUR ALWAYS-READY STUDY PARTNER"
                title="Meet your AI mentor"
                desc="Ask questions, explore concepts and get step-by-step explanations grounded in placement notes and your uploaded documents."
              />

              <div className="panel" style={{ marginBottom: 18, padding: 18 }}>
                <div className="eyebrow">RAG KNOWLEDGE BASE</div>
                <h3>Upload your placement study material</h3>
                <p className="muted">Upload PDF, DOCX, TXT, MD or CSV files (maximum 12 MB). PrepPilot extracts text, creates Gemini embeddings, stores vectors locally and retrieves relevant passages for AI answers, mock interviews and technical-topic practice.</p>
                <input type="file" accept=".pdf,.docx,.txt,.md,.csv" onChange={uploadKnowledgeFile} disabled={uploadingDoc} />
                {uploadingDoc && <p className="muted">Processing document and creating embeddings…</p>}
                {ragNotice && <p role="status">{ragNotice}</p>}
                <div className="eyebrow" style={{ marginTop: 12 }}>YOUR UPLOADED DOCUMENTS</div>
                {ragDocs.length ? ragDocs.map((doc) => <p key={doc.filename} className="muted">{doc.filename} · {doc.chunks} indexed chunks</p>) : <p className="muted">No personal documents uploaded yet. Built-in placement notes are available for RAG retrieval.</p>}
              </div>

              <div className="chat-layout">
                <div className="chat-main">
                  <div className="chat-top">
                    <div className="ai-avatar">
                      <Sparkles />
                    </div>

                    <div>
                      <b>PrepPilot AI</b>
                      <small>
                        <span className="online-dot" />
                        Ready to help you learn
                      </small>
                    </div>

                    <span className="tag">GEMINI + RAG</span>
                  </div>

                  <div className="chat-messages">
                    {messages.map((m, i) => (
                      <div
                        className={`message ${m.role}`}
                        key={i}
                      >
                        <div className="message-avatar">
                          {m.role === 'assistant'
                            ? <Sparkles size={15} />
                            : studentName.charAt(0).toUpperCase()}
                        </div>

                        <div className="bubble">{m.text}</div>
                      </div>
                    ))}

                    {busy && (
                      <div className="typing">
                        <LoaderCircle size={16} />
                        Thinking…
                      </div>
                    )}
                  </div>

                  <div className="chat-compose">
                    <input
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) =>
                        e.key === 'Enter' && sendChat()
                      }
                      placeholder="Ask your placement mentor anything..."
                    />

                    <button
                      onClick={sendChat}
                      disabled={busy || !input.trim()}
                    >
                      <Send size={17} />
                    </button>
                  </div>

                  <div className="chat-disclaimer">
                    AI can make mistakes. Verify important technical information.
                  </div>
                </div>

                <div className="chat-side panel">
                  <div className="eyebrow">TRY ASKING</div>

                  {[
                    'Explain OOP concepts with Python examples',
                    'Give me 5 SQL interview questions',
                    'How should I introduce myself in an interview?',
                    'Explain time complexity simply'
                  ].map((q) => (
                    <button
                      className="suggestion"
                      key={q}
                      onClick={() => setInput(q)}
                    >
                      {q} <ArrowUpRight size={14} />
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* MOCK INTERVIEW */}

          {page === 'Mock Interview' && (
            <>
              <PageIntro
                kicker="PRACTICE BEFORE THE REAL THING"
                title="Mock interview studio"
                desc="Generate a practice round and get constructive feedback on your answers."
              />

              <div className="mock-grid">
                <div className="panel">
                  <div className="eyebrow">SET UP YOUR SESSION</div>
                  <h3>Choose your interview style</h3>

                  <div className="choice-row">
                    {['Technical', 'HR', 'Mixed'].map((t) => (
                      <button
                        className={`choice ${mockType === t ? 'selected' : ''}`}
                        onClick={() => setMockType(t)}
                        key={t}
                      >
                        {t}
                      </button>
                    ))}
                  </div>

                  <button
                    className="primary-btn wide"
                    onClick={startMock}
                    disabled={busy}
                  >
                    {busy ? 'Preparing…' : 'Generate interview questions'}
                    <ArrowUpRight size={16} />
                  </button>

                  {mockQuestions && (
                    <div className="generated">
                      <b>Your questions</b>
                      <pre>{mockQuestions}</pre><small>RAG sources: {mockSources.length ? mockSources.join(", ") : "No matching source retrieved"}</small>
                    </div>
                  )}
                </div>

                <div className="panel">
                  <div className="eyebrow">YOUR ANSWERS</div>
                  <h3>Submit answers for feedback</h3>

                  <p className="muted">
                    Write one answer per paragraph. The AI will review
                    relevance, correctness, clarity and completeness.
                  </p>

                  <textarea
                    value={answers}
                    onChange={(e) => setAnswers(e.target.value)}
                    placeholder={'1. My answer is...\n\n2. My answer is...'}
                    rows="8"
                  />

                  <button
                    className="secondary-btn wide"
                    onClick={reviewMock}
                    disabled={busy || !answers.trim()}
                  >
                    Review my answers <Sparkles size={16} />
                  </button>

                  {mockFeedback && (
                    <div className="feedback-block">
                      <b>AI feedback</b>
                      <pre>{mockFeedback}</pre><small>RAG sources: {mockSources.length ? mockSources.join(", ") : "No matching source retrieved"}</small>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {/* PROGRESS */}

          {page === 'Progress' && (
            <>
              <PageIntro
                kicker="EVERY STEP COUNTS"
                title="Your progress"
                desc="Use your practice history to understand what to focus on next."
              />

              <div className="stats-grid">
                <Stat
                  icon={Target}
                  label="Readiness score"
                  value={`${dash?.readiness_score ?? 25}%`}
                  note="Demo calculation"
                  color="violet"
                />

                <Stat
                  icon={Brain}
                  label="Questions attempted"
                  value={dash?.aptitude_attempts ?? 0}
                  note="Aptitude practice"
                  color="blue"
                />

                <Stat
                  icon={CheckCircle2}
                  label="Accuracy"
                  value={`${dash?.aptitude_accuracy ?? 0}%`}
                  note="Correct answers"
                  color="orange"
                />

                <Stat
                  icon={Mic2}
                  label="Mock sessions"
                  value={dash?.mock_interviews ?? 0}
                  note="Reviewed sessions"
                  color="pink"
                />
              </div>

              <div className="panel activity-panel">
                <h3>Recent activity</h3>

                {dash?.recent_activity?.length ? (
                  dash.recent_activity.map((a, i) => (
                    <div className="activity-row" key={i}>
                      <div className="activity-check">
                        <CheckCircle2 size={16} />
                      </div>

                      <span>{a.label}</span>
                      <small>{new Date(a.time).toLocaleString()}</small>
                    </div>
                  ))
                ) : (
                  <p className="muted">
                    Your activity will appear here as you practice.
                  </p>
                )}
              </div>
            </>
          )}

          {selectedResource && (
            <div className="resource-overlay" role="presentation" onClick={() => setSelectedResource(null)}>
              <section className="resource-modal" role="dialog" aria-modal="true" aria-labelledby="resource-title" onClick={(e) => e.stopPropagation()}>
                <button className="resource-close" onClick={() => setSelectedResource(null)} aria-label="Close">×</button>
                <div className="eyebrow">{selectedResource.category}</div>
                <h2 id="resource-title">{selectedResource.title}</h2>
                <p>{selectedResource.description}</p>
                {selectedResource.kind === 'coding' ? (
                  <div className="resource-example">
                    <b>Practice task</b>
                    <p>Write your solution, test it with at least two inputs, and check edge cases such as empty input or duplicate values.</p>
                    <b>Example approach</b>
                    <p>Break the problem into input, processing and output. Choose a suitable data structure and explain the time complexity.</p>
                  </div>
                ) : (
                  <div className="resource-example">
                    <b>What to prepare</b>
                    <ul>
                      <li>Understand the concept in your own words.</li>
                      <li>Prepare one practical example.</li>
                      <li>Practice explaining it clearly in 60–90 seconds.</li>
                    </ul>
                    <b>Interview practice</b>
                    <p>Explain the topic, give an example, and mention where it is useful.</p>
                  </div>
                )}
                <button className="primary-btn" onClick={() => { setInput(`Help me prepare for ${selectedResource.title}. Explain it with examples and ask me interview questions.`); setSelectedResource(null); setPage('AI Mentor'); }}>Practice with AI Mentor <Sparkles size={16} /></button>
              </section>
            </div>
          )}

          <footer className="footer">
            PrepPilot <span>·</span> Learn. Practice. Improve. Get placement ready.
          </footer>

        </div>
      </main>
    </div>
  );
}

function Stat({ icon: Icon, label, value, note, color }) {
  return (
    <div className="stat-card">
      <div className={`stat-icon ${color}`}>
        <Icon size={19} />
      </div>

      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-note">{note}</div>
    </div>
  );
}

function Feature({ icon: Icon, title, desc, onClick, tone }) {
  return (
    <button className="feature-card" onClick={onClick}>
      <div className={`feature-icon ${tone}`}>
        <Icon size={20} />
      </div>

      <b>{title}</b>
      <p>{desc}</p>

      <ArrowUpRight className="feature-arrow" size={17} />
    </button>
  );
}

function PageIntro({ kicker, title, desc }) {
  return (
    <div className="page-intro">
      <div className="eyebrow">{kicker}</div>
      <h1>{title}</h1>
      <p>{desc}</p>
    </div>
  );
}

export default App;

