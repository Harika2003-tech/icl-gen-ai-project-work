
import { useEffect, useState } from "react";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  onAuthStateChanged,
  signOut,
  updateProfile,
  reload,
} from "firebase/auth";
import { auth } from "./firebase";
import "./auth.css";

const PROFILE_API = import.meta.env.VITE_API_URL || "http://localhost:8000";

async function syncStudentProfile(user) {
  const emailKey = (user.email || "").toLowerCase();
  let profile = {};
  try {
    profile = JSON.parse(localStorage.getItem(`preppilot-profile-${emailKey}`) || "{}");
  } catch {
    profile = {};
  }
  const payload = {
    name: profile.name || user.displayName || emailKey.split("@")[0] || "Student",
    college: profile.college || "",
    branch: profile.branch || "",
    year: profile.year || ""
  };
  const token = await user.getIdToken();
  const response = await fetch(`${PROFILE_API}/api/profile`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    console.warn("Student profile could not be synced to the backend.");
  }
}

export default function AuthGate({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [screen, setScreen] = useState("home");
  const [mode, setMode] = useState("login");
  const [name, setName] = useState("");
  const [college, setCollege] = useState("");
  const [branch, setBranch] = useState("");
  const [year, setYear] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      try {
        if (currentUser) {
          await reload(currentUser);
          if (currentUser.emailVerified) {
            setUser(currentUser);
          } else {
            setUser(null);
          }
        } else {
          setUser(null);
        }
      } catch {
        setUser(null);
      } finally {
        setLoading(false);
      }
    });

    return unsubscribe;
  }, []);

  const openAuth = (selectedMode) => {
    setMode(selectedMode);
    setScreen("auth");
    setError("");
    setMessage("");
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setMessage("");

    try {
      if (mode === "register") {
        const result = await createUserWithEmailAndPassword(
          auth,
          email.trim(),
          password
        );

        if (name.trim()) {
          await updateProfile(result.user, {
            displayName: name.trim(),
          });
        }

        localStorage.setItem(`preppilot-profile-${(email.trim()).toLowerCase()}`, JSON.stringify({
          name: name.trim(), college: college.trim(), branch: branch.trim(), year
        }));

        await sendEmailVerification(result.user);
        await signOut(auth);

        setMode("login");
        setMessage(
          "Registration successful! Check your inbox and verify your email before logging in."
        );
      } else if (mode === "login") {
        const result = await signInWithEmailAndPassword(
          auth,
          email.trim(),
          password
        );

        await reload(result.user);

        if (!result.user.emailVerified) {
          await sendEmailVerification(result.user);
          await signOut(auth);
          setMessage(
            "Your email is not verified yet. A new verification link has been sent."
          );
          return;
        }

        await result.user.getIdToken(true);
        await syncStudentProfile(result.user);
        setUser(result.user);
      } else {
        await sendPasswordResetEmail(auth, email.trim());
        setMessage("Password reset link sent. Please check your email.");
      }
    } catch (err) {
      const messages = {
        "auth/email-already-in-use":
          "This email is already registered. Please log in instead.",
        "auth/invalid-credential":
          "Incorrect email or password. Try resetting your password if needed.",
        "auth/too-many-requests":
          "Too many attempts. Please wait before trying again.",
        "auth/weak-password":
          "Please choose a password with at least 6 characters.",
        "auth/invalid-email":
          "Please enter a valid email address.",
      };

      setError(
        messages[err.code] ||
        err.message ||
        "Authentication failed. Please try again."
      );
    }
  };

  const handleResendVerification = async () => {
    setError("");
    setMessage("");

    try {
      const result = await signInWithEmailAndPassword(
        auth,
        email.trim(),
        password
      );

      await reload(result.user);

      if (result.user.emailVerified) {
        await result.user.getIdToken(true);
        setUser(result.user);
        return;
      }

      await sendEmailVerification(result.user);
      await signOut(auth);
      setMessage("Verification email sent. Please check your inbox.");
    } catch (err) {
      setError(
        err.code === "auth/too-many-requests"
          ? "Too many attempts. Please wait before trying again."
          : err.message
      );
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
    setUser(null);
    setScreen("home");
  };

  if (loading) {
    return (
      <div className="auth-loading">
        <div className="loading-logo">✦</div>
        <h2>PrepPilot</h2>
        <p>Preparing your workspace...</p>
      </div>
    );
  }

  if (user) {
    return (
      <>
        <div className="auth-user-bar">
          <span>
            Signed in as <strong>{user.displayName || user.email}</strong>
          </span>
          <button onClick={handleLogout}>Logout</button>
        </div>
        {children}
      </>
    );
  }

  return (
    <div className="public-site">
      <header className="landing-nav">
        <button
          className="landing-brand"
          onClick={() => setScreen("home")}
        >
          <span className="brand-symbol">✦</span>
          <span>
            <strong>PrepPilot</strong>
            <small>PLACEMENT COACH</small>
          </span>
        </button>

        <nav className="landing-links">
          <a href="#features">Features</a>
          <a href="#how-it-works">How it works</a>
          <a href="#about">About</a>
        </nav>

        <div className="landing-nav-actions">
          <button
            className="nav-login"
            onClick={() => openAuth("login")}
          >
            Login
          </button>
          <button
            className="nav-signup"
            onClick={() => openAuth("register")}
          >
            Get Started <span>↗</span>
          </button>
        </div>
      </header>

      {screen === "home" ? (
        <main>
          <section className="landing-hero">
            <div className="hero-content">
              <div className="hero-label">
                <span className="hero-label-dot" />
                YOUR PERSONAL PLACEMENT PREPARATION PARTNER
              </div>

              <h1>
                Your next opportunity
                <br />
                starts with <span>preparation.</span>
              </h1>

              <p className="hero-description">
                Prepare smarter for placements with aptitude practice,
                coding challenges, technical learning and AI-powered
                interview guidance — all in one place.
              </p>

              <div className="hero-buttons">
                <button
                  className="hero-primary"
                  onClick={() => openAuth("register")}
                >
                  Start Your Journey <span>→</span>
                </button>
                <button
                  className="hero-secondary"
                  onClick={() => openAuth("login")}
                >
                  Already have an account? Login
                </button>
              </div>

              <div className="hero-trust">
                <span>✓</span> Learn at your own pace
                <span>✓</span> Practice consistently
                <span>✓</span> Prepare with confidence
              </div>
            </div>

            <div className="hero-visual">
              <div className="visual-glow" />

              <div className="dashboard-preview">
                <div className="preview-top">
                  <div className="preview-brand">
                    <span>✦</span> PrepPilot
                  </div>
                  <span className="preview-status">● YOUR WORKSPACE</span>
                </div>

                <div className="preview-welcome">
                  <small>WELCOME TO YOUR JOURNEY</small>
                  <h3>Ready to grow?</h3>
                  <p>Every small step brings you closer to your goal.</p>
                </div>

                <div className="preview-score">
                  <div>
                    <small>YOUR PREPARATION</small>
                    <h2>100% <span>potential</span></h2>
                  </div>
                  <div className="score-circle">✦</div>
                </div>

                <div className="preview-grid">
                  <div className="preview-item">
                    <span className="preview-icon purple">◈</span>
                    <b>Aptitude</b>
                    <small>Sharpen your thinking</small>
                  </div>
                  <div className="preview-item">
                    <span className="preview-icon blue">⌘</span>
                    <b>Coding Lab</b>
                    <small>Build problem-solving skills</small>
                  </div>
                  <div className="preview-item">
                    <span className="preview-icon orange">✧</span>
                    <b>AI Mentor</b>
                    <small>Learn with AI guidance</small>
                  </div>
                  <div className="preview-item">
                    <span className="preview-icon pink">◎</span>
                    <b>Mock Interview</b>
                    <small>Practice with confidence</small>
                  </div>
                </div>

                <div className="preview-footer">
                  <span>✦</span> Your journey. Your progress. Your future.
                </div>
              </div>

              <div className="floating-note note-one">
                <span>✦</span>
                <div>
                  <b>AI-powered learning</b>
                  <small>Your personal study partner</small>
                </div>
              </div>

              <div className="floating-note note-two">
                <span>↗</span>
                <div>
                  <b>Keep improving</b>
                  <small>One step at a time</small>
                </div>
              </div>
            </div>
          </section>

          <section className="landing-stats">
            <div><strong>01</strong><span>Learn</span></div>
            <div><strong>02</strong><span>Practice</span></div>
            <div><strong>03</strong><span>Improve</span></div>
            <div><strong>04</strong><span>Get placement ready</span></div>
          </section>

          <section className="landing-section" id="features">
            <div className="section-overline">EVERYTHING IN ONE PLACE</div>
            <h2>Prepare for every stage of placement.</h2>
            <p className="section-description">
              A focused learning space to help you strengthen your skills
              and prepare for recruitment opportunities.
            </p>

            <div className="landing-feature-grid">
              {[
                ["◈", "Aptitude Practice", "Improve quantitative, logical and verbal reasoning."],
                ["⌘", "Coding Lab", "Strengthen programming and problem-solving skills."],
                ["▤", "Technical Preparation", "Revise programming, databases and core concepts."],
                ["◎", "HR Preparation", "Build confidence for common HR interview questions."],
                ["✧", "AI Mentor", "Get explanations and personalized learning guidance."],
                ["◉", "Mock Interviews", "Practice interview questions and receive AI feedback."],
              ].map(([icon, title, description]) => (
                <article className="landing-feature" key={title}>
                  <span>{icon}</span>
                  <h3>{title}</h3>
                  <p>{description}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="how-section" id="how-it-works">
            <div className="section-overline">A SIMPLE WAY FORWARD</div>
            <h2>Your preparation journey, simplified.</h2>
            <div className="how-grid">
              <div><b>01</b><h3>Create your account</h3><p>Register securely and access your personal workspace.</p></div>
              <div><b>02</b><h3>Choose your focus</h3><p>Explore aptitude, coding, technical and HR preparation.</p></div>
              <div><b>03</b><h3>Practice and improve</h3><p>Use AI guidance and track your learning progress.</p></div>
            </div>
          </section>

          <section className="landing-cta" id="about">
            <div className="section-overline">YOUR FUTURE STARTS HERE</div>
            <h2>Take the next step towards your dream opportunity.</h2>
            <p>Start preparing today. Your progress begins with one step.</p>
            <button
              className="hero-primary"
              onClick={() => openAuth("register")}
            >
              Get Started <span>→</span>
            </button>
          </section>

          <footer className="landing-footer">
            <strong>✦ PrepPilot</strong>
            <span>Learn. Practice. Improve. Get placement ready.</span>
            <small>© 2026 PrepPilot</small>
          </footer>
        </main>
      ) : (
        <main className="auth-page">
          <button
            className="back-home"
            onClick={() => {
              setScreen("home");
              setError("");
              setMessage("");
            }}
          >
            ← Back to home
          </button>

          <form className="auth-card" onSubmit={handleSubmit}>
            <div className="auth-logo">✦</div>
            <h1>PrepPilot</h1>
            <p className="auth-subtitle">
              Your personal placement preparation coach
            </p>

            <h2>
              {mode === "register"
                ? "Create your account"
                : mode === "reset"
                  ? "Reset your password"
                  : "Welcome back"}
            </h2>

            {mode === "register" && (
              <input
                type="text"
                placeholder="Full Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            )}

            {mode === "register" && (
              <>
                <input type="text" placeholder="College Name" value={college} onChange={(e) => setCollege(e.target.value)} required />
                <input type="text" placeholder="Branch (e.g. CSE AIML)" value={branch} onChange={(e) => setBranch(e.target.value)} required />
                <select value={year} onChange={(e) => setYear(e.target.value)} required>
                  <option value="">Select Year of Study</option>
                  <option value="1st Year">1st Year</option>
                  <option value="2nd Year">2nd Year</option>
                  <option value="3rd Year">3rd Year</option>
                  <option value="4th Year">4th Year</option>
                </select>
              </>
            )}

            <input
              type="email"
              placeholder="Email Address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />

            {mode !== "reset" && (
              <input
                type="password"
                placeholder="Password (minimum 6 characters)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={6}
                required
              />
            )}

            {error && <p className="auth-error">{error}</p>}
            {message && <p className="auth-message">{message}</p>}

            <button className="auth-submit" type="submit">
              {mode === "register"
                ? "Create Account"
                : mode === "reset"
                  ? "Send Reset Link"
                  : "Login"}
            </button>

            {mode === "login" && (
              <>
                <button
                  type="button"
                  className="auth-link"
                  onClick={() => {
                    setMode("reset");
                    setError("");
                    setMessage("");
                  }}
                >
                  Forgot Password?
                </button>

                <button
                  type="button"
                  className="auth-link"
                  onClick={handleResendVerification}
                  disabled={!email || !password}
                >
                  Resend Verification Email
                </button>

                <p className="auth-switch">
                  Don't have an account?{" "}
                  <button
                    type="button"
                    className="auth-link"
                    onClick={() => openAuth("register")}
                  >
                    Register
                  </button>
                </p>
              </>
            )}

            {mode !== "login" && (
              <button
                type="button"
                className="auth-link"
                onClick={() => openAuth("login")}
              >
                Back to Login
              </button>
            )}
          </form>
        </main>
      )}
    </div>
  );
}

