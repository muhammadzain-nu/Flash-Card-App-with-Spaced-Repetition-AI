import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Brain, BookOpen, LayoutDashboard, Share2, Zap, LogOut, Moon, Sun,
  Plus, Trash2, Edit3, ChevronRight, ArrowLeft, Download, Upload,
  X, Copy, Globe, Lock, RefreshCw, CheckCircle, XCircle, ChevronDown,
  Menu, Sparkles, FlipHorizontal, ClipboardList
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// FIREBASE SETUP
//
// SETUP CHECKLIST (follow these steps in order):
//  1. Go to https://console.firebase.google.com and click "Create a project"
//  2. Enable Authentication:
//     → Build → Authentication → Get started → Sign-in method → Email/Password → Enable
//  3. Enable Firestore:
//     → Build → Firestore Database → Create database → Start in test mode → Next → Enable
//  4. Get your config:
//     → Project Settings (gear icon) → Your apps → Web (</>) → Register app
//     → Copy the firebaseConfig object values into FIREBASE_CONFIG below
//  5. Replace each "YOUR_..." placeholder with the real value from Firebase Console
// ─────────────────────────────────────────────────────────────────────────────
import { initializeApp, getApps } from "firebase/app";
import {
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut as firebaseSignOut, onAuthStateChanged, User as FirebaseUser
} from "firebase/auth";
import {
  getFirestore, collection, doc, setDoc, getDoc, getDocs,
  query, where, deleteDoc, Timestamp
} from "firebase/firestore";

const FIREBASE_CONFIG = {
  apiKey: "API_Key",
  authDomain: "firebase_domain",
  projectId: "Your_ID",
  storageBucket: "Storage_ID",
  messagingSenderId: "key",
  appId: "Webapp_ID",
};

const FIREBASE_READY = FIREBASE_CONFIG.apiKey !== "YOUR_API_KEY";
const firebaseApp = FIREBASE_READY
  ? (getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG))
  : null;
const fbAuth = firebaseApp ? getAuth(firebaseApp) : null;
const fbDb = firebaseApp ? getFirestore(firebaseApp) : null;

// ─────────────────────────────────────────────────────────────────────────────
// GEMINI CONFIG
//
// ⚠️  CORS WARNING: Direct browser calls to generativelanguage.googleapis.com are
//     blocked by CORS policy in some environments. For production, route requests
//     through a serverless proxy. For local dev, you can use your API key directly.
//     Replace "YOUR_GEMINI_API_KEY" with your key from Google AI Studio.
// ─────────────────────────────────────────────────────────────────────────────
const GEMINI_API_KEY = "Your_API_Key";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────
interface Deck {
  id: string;
  name: string;
  ownerId?: string;
  public?: boolean;
  sharedWith?: string[];
  createdAt: number;
  updatedAt?: number;
}

interface Card {
  id: string;
  deckId: string;
  front: string;
  back: string;
  interval: number;
  repetitions: number;
  easeFactor: number;
  dueDate: number;
  createdAt: number;
}

interface QuizQuestion {
  question: string;
  correctAnswer: string;
  distractors: [string, string, string];
}

interface Toast {
  id: string;
  message: string;
  type: "success" | "error" | "info";
}

type AppView = "dashboard" | "decks" | "study" | "deck-detail";
type StudyPhase = "pick" | "session" | "complete";
type AuthMode = "login" | "signup";

// ─────────────────────────────────────────────────────────────────────────────
// SM-2 SPACED REPETITION ALGORITHM
// quality: 0=Again, 1=Hard, 2=Hard+, 3=Good, 4=Good+, 5=Easy
// ─────────────────────────────────────────────────────────────────────────────
function sm2(quality: number, repetitions: number, easeFactor: number, interval: number) {
  const newEF = Math.max(1.3, easeFactor + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  let newReps: number;
  let newInterval: number;
  if (quality < 3) {
    newReps = 0;
    newInterval = 1;
  } else {
    newReps = repetitions + 1;
    if (newReps === 1) newInterval = 1;
    else if (newReps === 2) newInterval = 6;
    else newInterval = Math.round(interval * newEF);
  }
  return { interval: newInterval, repetitions: newReps, easeFactor: newEF };
}

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE LAYER
// Guest mode: localStorage only.
// Logged-in: localStorage as cache, Firestore as source of truth.
// ─────────────────────────────────────────────────────────────────────────────
const storage = {
  // ── Local helpers ──────────────────────────────────────────────────────────
  localGetDecks(): Deck[] {
    try { return JSON.parse(localStorage.getItem("sx_decks") || "[]"); }
    catch { return []; }
  },
  localSaveDecks(decks: Deck[]) {
    localStorage.setItem("sx_decks", JSON.stringify(decks));
  },
  localGetCards(deckId: string): Card[] {
    try { return JSON.parse(localStorage.getItem(`sx_cards_${deckId}`) || "[]"); }
    catch { return []; }
  },
  localSaveCards(deckId: string, cards: Card[]) {
    localStorage.setItem(`sx_cards_${deckId}`, JSON.stringify(cards));
  },
  localGetQuizCache(deckId: string): QuizQuestion[] | null {
    try {
      const raw = localStorage.getItem(`sx_quiz_${deckId}`);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  localSaveQuizCache(deckId: string, quiz: QuizQuestion[]) {
    localStorage.setItem(`sx_quiz_${deckId}`, JSON.stringify(quiz));
  },

  // ── Firestore helpers (only called when FIREBASE_READY && user logged in) ──
  async fsGetDecks(uid: string): Promise<Deck[]> {
    if (!fbDb) return [];
    const q = query(collection(fbDb, "decks"), where("ownerId", "==", uid));
    const snap = await getDocs(q);
    return snap.docs.map(d => d.data() as Deck);
  },
  async fsSaveDeck(deck: Deck) {
    if (!fbDb) return;
    await setDoc(doc(fbDb, "decks", deck.id), deck);
  },
  async fsDeleteDeck(deckId: string) {
    if (!fbDb) return;
    await deleteDoc(doc(fbDb, "decks", deckId));
  },
  async fsGetCards(deckId: string): Promise<Card[]> {
    if (!fbDb) return [];
    const q = query(collection(fbDb, "cards"), where("deckId", "==", deckId));
    const snap = await getDocs(q);
    return snap.docs.map(d => d.data() as Card);
  },
  async fsSaveCard(card: Card) {
    if (!fbDb) return;
    await setDoc(doc(fbDb, "cards", card.id), card);
  },
  async fsDeleteCard(cardId: string) {
    if (!fbDb) return;
    await deleteDoc(doc(fbDb, "cards", cardId));
  },
  // Retrieve a shared deck by its ID (enforces permissions: public, owned, or explicitly shared)
  async fsGetSharedDeck(deckId: string): Promise<{ deck: Deck; cards: Card[] } | null> {
    if (!fbDb) return null;
    const deckSnap = await getDoc(doc(fbDb, "decks", deckId));
    if (!deckSnap.exists()) return null;
    const deck = deckSnap.data() as Deck;

    // Check if the current user has permission to access this deck
    const currentUser = fbAuth?.currentUser;
    const currentUid = currentUser?.uid;
    const currentEmail = currentUser?.email;

    const isOwner = !!(currentUid && deck.ownerId === currentUid);
    const isPublic = deck.public === true;
    const isShared = !!(
      (currentUid && deck.sharedWith?.includes(currentUid)) ||
      (currentEmail && deck.sharedWith?.includes(currentEmail))
    );

    if (!isPublic && !isOwner && !isShared) {
      return null;
    }

    const cardsQ = query(collection(fbDb, "cards"), where("deckId", "==", deckId));
    const cardsSnap = await getDocs(cardsQ);
    const cards = cardsSnap.docs.map(d => d.data() as Card);
    return { deck, cards };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// QUIZ AGENT — Gemini API (Free, Browser-Safe & CORS-Enabled)
// ─────────────────────────────────────────────────────────────────────────────
async function generateQuiz(cards: Card[]): Promise<QuizQuestion[]> {
  if (!GEMINI_API_KEY || GEMINI_API_KEY === "YOUR_GEMINI_API_KEY") {
    throw new Error("Gemini API key is not configured. Please set GEMINI_API_KEY at the top of App.tsx.");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

  const pairs = cards.map(c => ({ front: c.front, back: c.back }));

  // Formulate structured schema to ensure Gemini returns pristine JSON without markdown
  const payload = {
    contents: [
      {
        parts: [
          {
            text: `Generate quiz questions for these flashcards:\n${JSON.stringify(pairs, null, 2)}`
          }
        ]
      }
    ],
    systemInstruction: {
      parts: [
        {
          text: `You are a quiz generator. Given flashcard front/back pairs, generate quiz questions.
The "question" must be a natural-language question derived from the card's front.
The "correctAnswer" must be the card's back text (verbatim or lightly cleaned).
The "distractors" must be 3 plausible but wrong answers from the same domain.`
        }
      ]
    },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          questions: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                question: { type: "STRING" },
                correctAnswer: { type: "STRING" },
                distractors: {
                  type: "ARRAY",
                  items: { type: "STRING" }
                }
              },
              required: ["question", "correctAnswer", "distractors"]
            }
          }
        },
        required: ["questions"]
      }
    }
  };

  // Implement mandatory exponential backoff error handling
  let delay = 1000;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        const result = await response.json();
        const textResponse = result.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!textResponse) {
          throw new Error("Empty response received from the model.");
        }

        const parsedData = JSON.parse(textResponse);
        if (!parsedData.questions || !Array.isArray(parsedData.questions)) {
          throw new Error("Invalid response format received from the model.");
        }

        return parsedData.questions.map((q: any) => {
          const dist = Array.isArray(q.distractors) ? q.distractors : [];
          const distractors: [string, string, string] = [
            String(dist[0] || "Incorrect Option 1"),
            String(dist[1] || "Incorrect Option 2"),
            String(dist[2] || "Incorrect Option 3")
          ];
          return {
            question: String(q.question || ""),
            correctAnswer: String(q.correctAnswer || ""),
            distractors
          };
        });
      } else {
        try {
          const errorData = await response.json();
          if (errorData.error?.message) {
            throw new Error(`Gemini API Error: ${errorData.error.message}`);
          }
        } catch (e) {
          // ignore parsing error, throw HTTP error below
        }
        throw new Error(`Gemini API returned status ${response.status}: ${response.statusText}`);
      }
    } catch (error: any) {
      const isClientError = error.message && (
        error.message.includes("status 4") ||
        error.message.includes("API Error") ||
        error.message.includes("API key")
      );
      if (isClientError || attempt === 5) {
        throw error;
      }
    }

    // Wait before retrying (1s, 2s, 4s, 8s, 16s)
    await new Promise(resolve => setTimeout(resolve, delay));
    delay *= 2;
  }

  throw new Error("Failed to generate quiz after multiple attempts.");
}

async function generateCards(prompt: string, count: number): Promise<{ front: string; back: string }[]> {
  if (!GEMINI_API_KEY || GEMINI_API_KEY === "YOUR_GEMINI_API_KEY") {
    throw new Error("Gemini API key is not configured. Please set GEMINI_API_KEY at the top of App.tsx.");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

  const payload = {
    contents: [
      {
        parts: [{ text: `Generate exactly ${count} flashcard question and answer pairs for the topic or prompt: "${prompt}"` }]
      }
    ],
    systemInstruction: {
      parts: [
        {
          text: `You are an educational assistant. Generate concise flashcards.
The "front" is a question or concept.
The "back" is the answer or definition.`
        }
      ]
    },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          cards: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                front: { type: "STRING" },
                back: { type: "STRING" }
              },
              required: ["front", "back"]
            }
          }
        },
        required: ["cards"]
      }
    }
  };

  let delay = 1000;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        const result = await response.json();
        const textResponse = result.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (!textResponse) {
          throw new Error("Empty response received from the model.");
        }

        const parsedData = JSON.parse(textResponse);
        if (!parsedData.cards || !Array.isArray(parsedData.cards)) {
          throw new Error("Invalid response format received from the model.");
        }

        return parsedData.cards.map((c: any) => ({
          front: String(c.front || ""),
          back: String(c.back || "")
        }));
      } else {
        try {
          const errorData = await response.json();
          if (errorData.error?.message) {
            throw new Error(`Gemini API Error: ${errorData.error.message}`);
          }
        } catch (e) {
          // ignore
        }
        throw new Error(`Gemini API returned status ${response.status}: ${response.statusText}`);
      }
    } catch (error: any) {
      const isClientError = error.message && (
        error.message.includes("status 4") || 
        error.message.includes("API Error") ||
        error.message.includes("API key")
      );
      if (isClientError || attempt === 5) {
        throw error;
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, delay));
    delay *= 2;
  }

  throw new Error("Failed to generate cards after multiple attempts.");
}
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// UTILITY — id generator
// ─────────────────────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 11) + Date.now().toString(36);

// ─────────────────────────────────────────────────────────────────────────────
// TOAST COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
function ToastContainer({ toasts, onRemove }: { toasts: Toast[]; onRemove: (id: string) => void }) {
  return (
    <div className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-2 pointer-events-none">
      <AnimatePresence>
        {toasts.map(t => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40, scale: 0.95 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl text-sm font-medium min-w-[240px] ${t.type === "success" ? "bg-emerald-500 text-white" :
              t.type === "error" ? "bg-red-500 text-white" :
                "bg-indigo-600 text-white"
              }`}
          >
            {t.type === "success" ? <CheckCircle size={16} /> : t.type === "error" ? <XCircle size={16} /> : <Sparkles size={16} />}
            <span className="flex-1">{t.message}</span>
            <button onClick={() => onRemove(t.id)} className="opacity-70 hover:opacity-100"><X size={14} /></button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MODAL WRAPPER
// ─────────────────────────────────────────────────────────────────────────────
function ModalBackdrop({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[800] flex items-center justify-center p-4"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
          <motion.div
            className="relative z-10 w-full"
            initial={{ opacity: 0, scale: 0.94, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: 10 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HERO SECTION
// ─────────────────────────────────────────────────────────────────────────────
function HeroSection({
  onEnterApp,
  onAuthSuccess,
  addToast,
}: {
  onEnterApp: () => void;
  onAuthSuccess: (user: FirebaseUser) => void;
  addToast: (msg: string, type: Toast["type"]) => void;
}) {
  const [cardFlipped, setCardFlipped] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [loading, setLoading] = useState(false);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const [scrolled, setScrolled] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (cardFlipped) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    setTilt({ x: y * -18, y: x * 18 });
  };
  const handleMouseLeave = () => setTilt({ x: 0, y: 0 });

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    if (!email.trim()) return setAuthError("Email is required.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setAuthError("Enter a valid email address.");
    if (password.length < 6) return setAuthError("Password must be at least 6 characters.");
    if (!FIREBASE_READY || !fbAuth) return setAuthError("Firebase not configured. Fill in FIREBASE_CONFIG in App.tsx.");
    setLoading(true);
    try {
      const cred = authMode === "login"
        ? await signInWithEmailAndPassword(fbAuth, email, password)
        : await createUserWithEmailAndPassword(fbAuth, email, password);
      onAuthSuccess(cred.user);
      onEnterApp();
    } catch (err: any) {
      const msg = err.code === "auth/user-not-found" ? "No account with that email."
        : err.code === "auth/wrong-password" ? "Incorrect password."
          : err.code === "auth/email-already-in-use" ? "That email is already registered."
            : err.message ?? "Authentication failed.";
      setAuthError(msg);
    } finally {
      setLoading(false);
    }
  };

  const features = [
    { icon: Brain, label: "SM-2 Algorithm", desc: "Scientifically optimized review scheduling" },
    { icon: Sparkles, label: "AI Quiz Mode", desc: "Claude generates quizzes from your decks" },
    { icon: Share2, label: "Deck Sharing", desc: "Share decks publicly or with specific users" },
    { icon: Zap, label: "Offline-First", desc: "Works without internet, syncs when connected" },
  ];

  return (
    <div className="relative min-h-[100dvh] overflow-hidden" style={{ background: "#05050f" }}>
      {/* Ambient orbs */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-40 -left-40 w-[600px] h-[600px] rounded-full opacity-20"
          style={{ background: "radial-gradient(circle, #4338ca 0%, transparent 70%)" }} />
        <div className="absolute top-1/3 -right-20 w-[500px] h-[500px] rounded-full opacity-15"
          style={{ background: "radial-gradient(circle, #7c3aed 0%, transparent 70%)" }} />
        <div className="absolute bottom-0 left-1/3 w-[400px] h-[400px] rounded-full opacity-10"
          style={{ background: "radial-gradient(circle, #0ea5e9 0%, transparent 70%)" }} />
        {/* Grid overlay */}
        <div className="absolute inset-0 opacity-[0.03]"
          style={{ backgroundImage: "linear-gradient(rgba(255,255,255,0.8) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.8) 1px, transparent 1px)", backgroundSize: "60px 60px" }} />
      </div>

      {/* Nav bar */}
      <nav className="relative z-10 flex items-center justify-between px-8 py-5">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #6366f1, #a78bfa)" }}>
            <Brain size={16} className="text-white" />
          </div>
          <span className="text-white font-bold text-lg" style={{ fontFamily: "Outfit, sans-serif" }}>Simplex</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => { setCardFlipped(true); setAuthMode("login"); }}
            className="text-sm text-white/60 hover:text-white transition-colors px-4 py-2"
          >
            Sign In
          </button>
          <button
            onClick={onEnterApp}
            className="text-sm font-semibold px-5 py-2 rounded-lg text-white transition-all hover:opacity-90 active:scale-95"
            style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}
          >
            Get Started
          </button>
        </div>
      </nav>

      {/* Hero content */}
      <div className="relative z-10 container mx-auto px-8 pt-16 pb-20 grid grid-cols-1 lg:grid-cols-2 gap-16 items-center min-h-[calc(100vh-80px)]">
        {/* Left — copy */}
        <motion.div
          initial={{ opacity: 0, x: -30 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col gap-6"
        >
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold self-start"
            style={{ background: "rgba(99, 102, 241, 0.2)", border: "1px solid rgba(99, 102, 241, 0.4)", color: "#a5b4fc" }}
          >
            <Sparkles size={12} /> Spaced Repetition, Simplified
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.7 }}
            className="text-6xl lg:text-7xl font-black leading-[1.05] text-white"
            style={{ fontFamily: "Outfit, sans-serif", letterSpacing: "-0.02em" }}
          >
            Less brute force,<br />
            more{" "}
            <span className="relative inline-block">
              <span style={{ background: "linear-gradient(135deg, #818cf8, #a78bfa)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                strategy
              </span>
              <motion.span
                className="absolute -bottom-1 left-0 h-[3px] rounded-full"
                style={{ background: "linear-gradient(90deg, #6366f1, #a78bfa)", width: "100%" }}
                initial={{ scaleX: 0, originX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ delay: 0.9, duration: 0.6 }}
              />
            </span>
            .
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.35 }}
            className="text-lg leading-relaxed max-w-lg"
            style={{ color: "rgba(255,255,255,0.55)" }}
          >
            Master any subject with interactive flashcards powered by the SM-2 algorithm — designed to improve memory retention and slash study time.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
            className="flex items-center gap-3 flex-wrap"
          >
            <button
              onClick={onEnterApp}
              className="flex items-center gap-2 px-7 py-3.5 rounded-xl font-semibold text-white transition-all hover:shadow-lg hover:shadow-indigo-500/30 active:scale-95"
              style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)", fontFamily: "Outfit, sans-serif" }}
            >
              Get Started Free <ChevronRight size={18} />
            </button>
            <button
              onClick={() => { setCardFlipped(true); setAuthMode("login"); }}
              className="px-7 py-3.5 rounded-xl font-semibold transition-all hover:bg-white/10 active:scale-95"
              style={{ border: "1px solid rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.75)", fontFamily: "Outfit, sans-serif" }}
            >
              Sign In
            </button>
          </motion.div>

          {/* Feature pills */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.7 }}
            className="grid grid-cols-2 gap-3 mt-2"
          >
            {features.map((f, i) => (
              <motion.div
                key={f.label}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.7 + i * 0.08 }}
                className="flex items-start gap-3 p-3 rounded-xl"
                style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)" }}
              >
                <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
                  style={{ background: "rgba(99, 102, 241, 0.2)" }}>
                  <f.icon size={14} style={{ color: "#a5b4fc" }} />
                </div>
                <div>
                  <p className="text-xs font-semibold text-white/80">{f.label}</p>
                  <p className="text-xs" style={{ color: "rgba(255,255,255,0.4)" }}>{f.desc}</p>
                </div>
              </motion.div>
            ))}
          </motion.div>
        </motion.div>

        {/* Right — 3D card stack */}
        <motion.div
          initial={{ opacity: 0, x: 30 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.7, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="relative flex items-center justify-center h-[420px]"
        >
          {/* Back card 2 */}
          <div
            className="absolute w-[340px] rounded-2xl p-6 overflow-hidden"
            style={{
              height: 220,
              background: "rgba(99, 102, 241, 0.08)",
              border: "1px solid rgba(99, 102, 241, 0.2)",
              backdropFilter: "blur(12px)",
              transform: "rotate(-12deg) translateX(-50px) translateY(20px) scale(0.9)",
              boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
            }}
          >
            <div className="text-xs font-mono text-indigo-400/50 mb-3">interval: 6 days</div>
            <div className="text-white/30 text-sm">What is the time complexity of quicksort?</div>
          </div>

          {/* Back card 1 */}
          <div
            className="absolute w-[340px] rounded-2xl p-6"
            style={{
              height: 220,
              background: "rgba(139, 92, 246, 0.1)",
              border: "1px solid rgba(139, 92, 246, 0.25)",
              backdropFilter: "blur(16px)",
              transform: "rotate(-5deg) translateX(-20px) translateY(10px) scale(0.95)",
              boxShadow: "0 30px 80px rgba(0,0,0,0.5)",
            }}
          >
            <div className="text-xs font-mono text-violet-400/60 mb-3">interval: 14 days</div>
            <div className="text-white/50 text-sm">What is a closure in JavaScript?</div>
          </div>

          {/* Interactive front card — flips to show login */}
          <div
            ref={cardRef}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            className="absolute w-[340px] cursor-pointer"
            style={{
              height: 240,
              perspective: "1000px",
              zIndex: 10,
            }}
          >
            <div
              className="relative w-full h-full"
              style={{
                transformStyle: "preserve-3d",
                transition: cardFlipped
                  ? "transform 0.7s cubic-bezier(0.4, 0, 0.2, 1)"
                  : `transform ${tilt.x === 0 && tilt.y === 0 ? "0.5s" : "0.08s"} ease`,
                transform: cardFlipped
                  ? "rotateY(180deg)"
                  : `perspective(1000px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
              }}
            >
              {/* Front face */}
              <div
                className="absolute inset-0 rounded-2xl p-6 flex flex-col justify-between overflow-hidden"
                style={{
                  backfaceVisibility: "hidden",
                  background: "linear-gradient(135deg, rgba(99,102,241,0.25) 0%, rgba(139,92,246,0.15) 100%)",
                  border: "1px solid rgba(255,255,255,0.2)",
                  backdropFilter: "blur(24px)",
                  boxShadow: "0 30px 80px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.15)",
                }}
              >
                {/* Shine effect */}
                <div className="absolute inset-0 rounded-2xl pointer-events-none"
                  style={{ background: "linear-gradient(135deg, rgba(255,255,255,0.1) 0%, transparent 50%)" }} />
                <div className="flex items-center justify-between">
                  <span className="font-bold text-white text-lg" style={{ fontFamily: "Outfit, sans-serif" }}>Simplex</span>
                  <div className="flex gap-1">
                    <span style={{ color: "#a78bfa" }}>✦</span>
                    <span style={{ color: "rgba(167,139,250,0.4)" }}>✧</span>
                  </div>
                </div>
                <div>
                  <p className="text-white/80 text-sm leading-relaxed">
                    Create, study, and master any subject with flashcards designed to{" "}
                    <span style={{ color: "#a5b4fc" }}>improve memory</span> and{" "}
                    <span style={{ color: "#f9a8d4" }}>boost retention</span>.
                  </p>
                </div>
                <div className="flex items-center justify-between">
                  <div
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold text-white cursor-pointer hover:bg-white/10 transition-colors"
                    style={{ border: "1px solid rgba(255,255,255,0.2)" }}
                    onClick={() => setCardFlipped(true)}
                  >
                    <FlipHorizontal size={12} /> Flip to Sign In
                  </div>
                  <div className="text-white/30 text-xs">Due: Today</div>
                </div>
              </div>

              {/* Back face — Login / Signup */}
              <div
                className="absolute inset-0 rounded-2xl p-6 flex flex-col"
                style={{
                  backfaceVisibility: "hidden",
                  transform: "rotateY(180deg)",
                  background: "linear-gradient(135deg, rgba(15,15,35,0.95) 0%, rgba(25,15,50,0.95) 100%)",
                  border: "1px solid rgba(255,255,255,0.15)",
                  backdropFilter: "blur(24px)",
                  boxShadow: "0 30px 80px rgba(0,0,0,0.7)",
                }}
              >
                <div className="flex items-center justify-between mb-4">
                  <span className="font-bold text-white text-base" style={{ fontFamily: "Outfit, sans-serif" }}>
                    {authMode === "login" ? "Welcome Back" : "Create Account"}
                  </span>
                  <button
                    onClick={() => setCardFlipped(false)}
                    className="text-white/40 hover:text-white/80 transition-colors text-xs flex items-center gap-1"
                  >
                    <ArrowLeft size={12} /> Back
                  </button>
                </div>
                <form onSubmit={handleAuth} className="flex flex-col gap-2.5 flex-1">
                  <input
                    type="email"
                    placeholder="your@email.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg text-xs text-white placeholder-white/30 outline-none focus:ring-1 focus:ring-indigo-500/60"
                    style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.12)" }}
                  />
                  <input
                    type="password"
                    placeholder="Password (6+ chars)"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg text-xs text-white placeholder-white/30 outline-none focus:ring-1 focus:ring-indigo-500/60"
                    style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.12)" }}
                  />
                  {authError && <p className="text-xs text-red-400">{authError}</p>}
                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-2 rounded-lg text-xs font-semibold text-white transition-all hover:opacity-90 disabled:opacity-50 mt-1"
                    style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}
                  >
                    {loading ? "…" : authMode === "login" ? "Log In" : "Sign Up"}
                  </button>
                  <div className="flex items-center justify-between text-[10px] mt-0.5">
                    <button
                      type="button"
                      onClick={() => { setAuthMode(m => m === "login" ? "signup" : "login"); setAuthError(""); }}
                      className="text-indigo-400 hover:text-indigo-300 transition-colors"
                    >
                      {authMode === "login" ? "No account? Sign Up" : "Have account? Log In"}
                    </button>
                    <button type="button" onClick={onEnterApp} className="text-white/30 hover:text-white/60 transition-colors">
                      Guest →
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Scroll hint */}
      <motion.div
        className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2"
        initial={{ opacity: 0 }}
        animate={{ opacity: scrolled ? 0 : 0.5 }}
        transition={{ delay: 1.5 }}
      >
        <span className="text-white/40 text-xs tracking-widest uppercase" style={{ fontFamily: "Outfit, sans-serif" }}>Scroll</span>
        <motion.div
          animate={{ y: [0, 6, 0] }}
          transition={{ repeat: Infinity, duration: 1.5 }}
        >
          <ChevronDown size={16} className="text-white/40" />
        </motion.div>
      </motion.div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STAT CARD
// ─────────────────────────────────────────────────────────────────────────────
function StatCard({ icon, value, label, accent }: { icon: React.ReactNode; value: string | number; label: string; accent?: boolean }) {
  return (
    <motion.div
      whileHover={{ y: -3, scale: 1.02 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
      className="bg-card border border-border rounded-2xl p-5 flex flex-col gap-3"
    >
      <div className="w-10 h-10 rounded-xl flex items-center justify-center"
        style={{ background: accent ? "linear-gradient(135deg, #6366f1, #8b5cf6)" : "var(--muted)" }}>
        <span className={accent ? "text-white" : "text-muted-foreground"}>{icon}</span>
      </div>
      <div>
        <div className={`text-2xl font-bold ${accent ? "text-primary" : "text-foreground"}`}
          style={{ fontFamily: "Outfit, sans-serif" }}>{value}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
      </div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DECK CARD
// ─────────────────────────────────────────────────────────────────────────────
function DeckCard({
  deck, cards, onStudy, onOpen, onEdit, onDelete, onShare,
}: {
  deck: Deck; cards: Card[]; onStudy: () => void; onOpen: () => void;
  onEdit: () => void; onDelete: () => void; onShare: () => void;
}) {
  const dueCount = cards.filter(c => c.dueDate <= Date.now()).length;
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <motion.div
      whileHover={{ y: -4 }}
      transition={{ type: "spring", stiffness: 300, damping: 25 }}
      className="bg-card border border-border rounded-2xl p-5 cursor-pointer group relative flex flex-col gap-4"
      onClick={onOpen}
    >
      <div className="flex items-start justify-between">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}>
          <BookOpen size={18} className="text-white" />
        </div>
        <div className="relative">
          <button
            onClick={e => { e.stopPropagation(); setMenuOpen(v => !v); }}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
          >
            <Edit3 size={14} />
          </button>
          <AnimatePresence>
            {menuOpen && (
              <motion.div
                initial={{ opacity: 0, scale: 0.9, y: -5 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: -5 }}
                transition={{ type: "spring", stiffness: 400, damping: 30 }}
                className="absolute right-0 top-9 z-50 rounded-xl shadow-2xl border border-border overflow-hidden min-w-[140px]"
                style={{ background: "var(--popover)" }}
                onClick={e => e.stopPropagation()}
              >
                {[
                  { icon: Edit3, label: "Edit", action: () => { setMenuOpen(false); onEdit(); } },
                  { icon: Share2, label: "Share", action: () => { setMenuOpen(false); onShare(); } },
                  { icon: Trash2, label: "Delete", action: () => { setMenuOpen(false); onDelete(); }, danger: true },
                ].map(item => (
                  <button
                    key={item.label}
                    onClick={item.action}
                    className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm hover:bg-muted transition-colors text-left ${item.danger ? "text-destructive" : "text-foreground"}`}
                  >
                    <item.icon size={13} /> {item.label}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
      <div>
        <h3 className="font-bold text-foreground text-base leading-tight" style={{ fontFamily: "Outfit, sans-serif" }}>{deck.name}</h3>
        <p className="text-xs text-muted-foreground mt-1">{cards.length} cards</p>
      </div>
      <div className="flex items-center justify-between">
        {dueCount > 0 ? (
          <span className="text-xs font-medium px-2.5 py-1 rounded-lg" style={{ background: "rgba(99,102,241,0.12)", color: "#818cf8" }}>
            {dueCount} due
          </span>
        ) : (
          <span className="text-xs font-medium px-2.5 py-1 rounded-lg" style={{ background: "rgba(52,211,153,0.12)", color: "#34d399" }}>
            Up to date
          </span>
        )}
        <button
          onClick={e => { e.stopPropagation(); onStudy(); }}
          className="text-xs font-semibold flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-white transition-all hover:opacity-90 active:scale-95"
          style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}
        >
          <Brain size={11} /> Study
        </button>
      </div>
      {/* 3D card decoration */}
      <div
        className="absolute -right-3 -top-3 w-16 h-16 rounded-full opacity-10 pointer-events-none"
        style={{ background: "radial-gradient(circle, #6366f1, transparent)" }}
      />
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DECK MODAL
// ─────────────────────────────────────────────────────────────────────────────
function DeckModal({
  open, onClose, onSave, initialName = "",
}: {
  open: boolean; onClose: () => void; onSave: (name: string) => void; initialName?: string;
}) {
  const [name, setName] = useState(initialName);
  useEffect(() => { if (open) setName(initialName); }, [open, initialName]);
  return (
    <ModalBackdrop open={open} onClose={onClose}>
      <div className="max-w-md mx-auto bg-card border border-border rounded-2xl p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-bold text-lg text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
            {initialName ? "Edit Deck" : "New Deck"}
          </h3>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-muted text-muted-foreground"><X size={16} /></button>
        </div>
        <input
          type="text"
          placeholder="e.g. JavaScript Fundamentals"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && name.trim()) { onSave(name.trim()); } }}
          className="w-full px-4 py-3 rounded-xl bg-input-background border border-border text-foreground outline-none focus:ring-2 focus:ring-primary/30 text-sm"
          autoFocus
        />
        <div className="flex gap-2 mt-4 justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-muted-foreground hover:bg-muted transition-colors">Cancel</button>
          <button
            onClick={() => { if (name.trim()) onSave(name.trim()); }}
            disabled={!name.trim()}
            className="px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-40 transition-all hover:opacity-90"
            style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}
          >
            Save Deck
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CARD MODAL
// ─────────────────────────────────────────────────────────────────────────────
function CardModal({
  open, onClose, onSave, initialFront = "", initialBack = "",
}: {
  open: boolean; onClose: () => void;
  onSave: (front: string, back: string) => void;
  initialFront?: string; initialBack?: string;
}) {
  const [front, setFront] = useState(initialFront);
  const [back, setBack] = useState(initialBack);
  useEffect(() => { if (open) { setFront(initialFront); setBack(initialBack); } }, [open, initialFront, initialBack]);
  return (
    <ModalBackdrop open={open} onClose={onClose}>
      <div className="max-w-lg mx-auto bg-card border border-border rounded-2xl p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-bold text-lg text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
            {initialFront ? "Edit Card" : "Add Card"}
          </h3>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-muted text-muted-foreground"><X size={16} /></button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">Front</label>
            <textarea
              placeholder="Question or prompt..."
              value={front}
              onChange={e => setFront(e.target.value)}
              rows={5}
              className="w-full px-4 py-3 rounded-xl bg-input-background border border-border text-foreground outline-none focus:ring-2 focus:ring-primary/30 text-sm resize-none"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">Back</label>
            <textarea
              placeholder="Answer or explanation..."
              value={back}
              onChange={e => setBack(e.target.value)}
              rows={5}
              className="w-full px-4 py-3 rounded-xl bg-input-background border border-border text-foreground outline-none focus:ring-2 focus:ring-primary/30 text-sm resize-none"
            />
          </div>
        </div>
        <div className="flex gap-2 mt-4 justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-muted-foreground hover:bg-muted transition-colors">Cancel</button>
          <button
            onClick={() => { if (front.trim() && back.trim()) onSave(front.trim(), back.trim()); }}
            disabled={!front.trim() || !back.trim()}
            className="px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-40 transition-all hover:opacity-90"
            style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}
          >
            Save Card
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIRM MODAL
// ─────────────────────────────────────────────────────────────────────────────
function ConfirmModal({
  open, onClose, onConfirm, message,
}: {
  open: boolean; onClose: () => void; onConfirm: () => void; message: string;
}) {
  return (
    <ModalBackdrop open={open} onClose={onClose}>
      <div className="max-w-sm mx-auto bg-card border border-border rounded-2xl p-6 shadow-2xl">
        <h3 className="font-bold text-base text-foreground mb-2" style={{ fontFamily: "Outfit, sans-serif" }}>Confirm Action</h3>
        <p className="text-sm text-muted-foreground mb-5">{message}</p>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-muted-foreground hover:bg-muted transition-colors">Cancel</button>
          <button
            onClick={() => { onConfirm(); onClose(); }}
            className="px-5 py-2 rounded-xl text-sm font-semibold text-white bg-destructive hover:bg-destructive/90 transition-colors"
          >
            Delete
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARE MODAL
// ─────────────────────────────────────────────────────────────────────────────
function ShareModal({
  open, onClose, deck, onTogglePublic, addToast,
}: {
  open: boolean; onClose: () => void; deck?: Deck;
  onTogglePublic: (deckId: string, pub: boolean) => void;
  addToast: (msg: string, type: Toast["type"]) => void;
}) {
  const shareLink = deck ? `${window.location.origin}/?share=${deck.id}` : "";
  const [isPublic, setIsPublic] = useState(deck?.public ?? false);
  useEffect(() => { if (open && deck) setIsPublic(deck.public ?? false); }, [open, deck]);

  const handleTogglePublic = (val: boolean) => {
    setIsPublic(val);
    if (deck) {
      if (!FIREBASE_READY) {
        addToast("Configure Firebase to enable sharing.", "error");
      } else {
        onTogglePublic(deck.id, val);
        addToast(`Deck is now ${val ? "public" : "invite-only"}.`, "success");
      }
    }
  };

  return (
    <ModalBackdrop open={open} onClose={onClose}>
      <div className="max-w-md mx-auto bg-card border border-border rounded-2xl p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-bold text-lg text-foreground flex items-center gap-2" style={{ fontFamily: "Outfit, sans-serif" }}>
            <Share2 size={18} /> Share Deck
          </h3>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-muted text-muted-foreground"><X size={16} /></button>
        </div>

        {!FIREBASE_READY && (
          <div className="mb-4 px-4 py-3 rounded-xl text-xs" style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", color: "#f87171" }}>
            Firebase not configured. Fill in FIREBASE_CONFIG in App.tsx to enable sharing.
          </div>
        )}

        <p className="text-xs text-muted-foreground mb-4">Share this link with anyone to give them access to <strong className="text-foreground">{deck?.name}</strong>.</p>

        <div className="flex gap-2 mb-5">
          <input
            readOnly
            value={shareLink}
            className="flex-1 px-3 py-2 rounded-xl text-xs bg-input-background border border-border text-muted-foreground outline-none font-mono"
          />
          <button
            onClick={() => { navigator.clipboard.writeText(shareLink); addToast("Link copied!", "success"); }}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-white transition-all hover:opacity-90"
            style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}
          >
            <Copy size={12} /> Copy
          </button>
        </div>

        <div className="border-t border-border pt-4">
          <p className="text-xs font-semibold text-muted-foreground mb-3 uppercase tracking-wide">Access Control</p>
          <div className="flex gap-2">
            <button
              onClick={() => handleTogglePublic(true)}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-semibold transition-all ${isPublic ? "text-white" : "text-muted-foreground hover:bg-muted border border-border"}`}
              style={isPublic ? { background: "linear-gradient(135deg, #6366f1, #8b5cf6)" } : {}}
            >
              <Globe size={13} /> Public
            </button>
            <button
              onClick={() => handleTogglePublic(false)}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-semibold transition-all ${!isPublic ? "text-white" : "text-muted-foreground hover:bg-muted border border-border"}`}
              style={!isPublic ? { background: "linear-gradient(135deg, #374151, #4b5563)" } : {}}
            >
              <Lock size={13} /> Invite Only
            </button>
          </div>
        </div>
      </div>
    </ModalBackdrop>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// QUIZ MODAL
// ─────────────────────────────────────────────────────────────────────────────
function QuizModal({
  open, onClose, deck, cards, addToast,
}: {
  open: boolean; onClose: () => void; deck?: Deck; cards: Card[]; addToast: (msg: string, type: Toast["type"]) => void;
}) {
  const [phase, setPhase] = useState<"idle" | "loading" | "quiz" | "results">("idle");
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [qIndex, setQIndex] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [answers, setAnswers] = useState<boolean[]>([]);
  const [wrongCards, setWrongCards] = useState<QuizQuestion[]>([]);

  useEffect(() => {
    if (open && deck) {
      const cached = storage.localGetQuizCache(deck.id);
      if (cached) { setQuestions(cached); setPhase("quiz"); setQIndex(0); setAnswers([]); setWrongCards([]); setSelected(null); }
      else { handleGenerate(); }
    }
    if (!open) setPhase("idle");
  }, [open]);

  const handleGenerate = async () => {
    if (cards.length === 0) { addToast("Add some cards first!", "error"); return; }
    setPhase("loading");
    try {
      const quiz = await generateQuiz(cards);
      if (deck) storage.localSaveQuizCache(deck.id, quiz);
      setQuestions(quiz);
      setPhase("quiz");
      setQIndex(0);
      setAnswers([]);
      setWrongCards([]);
      setSelected(null);
    } catch (err: any) {
      console.error(err);
      const errMsg = err?.message || "Quiz generation failed. Check your API key and CORS setup.";
      addToast(errMsg, "error");
      setPhase("idle");
    }
  };

  const handleRegenerate = () => {
    if (deck) storage.localSaveQuizCache(deck.id, []);
    handleGenerate();
  };

  const currentQ = questions[qIndex];
  const allOptions = useMemo(() => {
    if (!currentQ) return [];
    return [...currentQ.distractors, currentQ.correctAnswer].sort(() => Math.random() - 0.5);
  }, [qIndex, questions]);

  const handleAnswer = (option: string) => {
    if (selected) return;
    setSelected(option);
    const correct = option === currentQ.correctAnswer;
    const newAnswers = [...answers, correct];
    if (!correct) setWrongCards(prev => [...prev, currentQ]);
    if (qIndex + 1 >= questions.length) {
      setTimeout(() => { setAnswers(newAnswers); setPhase("results"); }, 800);
    } else {
      setTimeout(() => { setQIndex(i => i + 1); setSelected(null); }, 700);
    }
  };

  const score = answers.filter(Boolean).length;

  return (
    <ModalBackdrop open={open} onClose={onClose}>
      <div className="max-w-lg mx-auto bg-card border border-border rounded-2xl p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-bold text-lg text-foreground flex items-center gap-2" style={{ fontFamily: "Outfit, sans-serif" }}>
            <ClipboardList size={18} /> AI Quiz — {deck?.name}
          </h3>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-muted text-muted-foreground"><X size={16} /></button>
        </div>

        {phase === "loading" && (
          <div className="flex flex-col items-center py-12 gap-4">
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
              className="w-10 h-10 rounded-full border-2 border-primary/20 border-t-primary"
            />
            <p className="text-sm text-muted-foreground">Generating quiz with Claude AI…</p>
          </div>
        )}

        {phase === "quiz" && currentQ && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs text-muted-foreground font-mono">Question {qIndex + 1} / {questions.length}</span>
              <button onClick={handleRegenerate} className="text-xs flex items-center gap-1 text-muted-foreground hover:text-primary transition-colors">
                <RefreshCw size={12} /> Regenerate
              </button>
            </div>
            <div className="w-full bg-muted rounded-full h-1 mb-5">
              <div className="h-1 rounded-full transition-all" style={{ width: `${((qIndex) / questions.length) * 100}%`, background: "linear-gradient(90deg, #6366f1, #a78bfa)" }} />
            </div>
            <p className="font-semibold text-foreground mb-4 leading-relaxed" style={{ fontFamily: "Outfit, sans-serif" }}>{currentQ.question}</p>
            <div className="flex flex-col gap-2">
              {allOptions.map((opt, i) => {
                const isSelected = selected === opt;
                const isCorrect = opt === currentQ.correctAnswer;
                const revealed = !!selected;
                return (
                  <motion.button
                    key={i}
                    whileTap={!selected ? { scale: 0.98 } : {}}
                    onClick={() => handleAnswer(opt)}
                    disabled={!!selected}
                    className={`text-left px-4 py-3 rounded-xl text-sm font-medium transition-all border ${revealed && isCorrect ? "border-emerald-500/50 text-emerald-400"
                      : revealed && isSelected && !isCorrect ? "border-red-500/50 text-red-400"
                        : "border-border text-foreground hover:border-primary/40 hover:bg-primary/5"
                      }`}
                    style={revealed && isCorrect ? { background: "rgba(52,211,153,0.1)" }
                      : revealed && isSelected && !isCorrect ? { background: "rgba(239,68,68,0.1)" }
                        : { background: "var(--input-background)" }}
                  >
                    <span className="font-mono text-xs mr-2 text-muted-foreground">{String.fromCharCode(65 + i)}.</span>
                    {opt}
                  </motion.button>
                );
              })}
            </div>
          </div>
        )}

        {phase === "results" && (
          <div className="flex flex-col items-center gap-5 py-4">
            <div className="text-5xl">{score / questions.length >= 0.8 ? "🎉" : score / questions.length >= 0.5 ? "🤔" : "📚"}</div>
            <div className="text-center">
              <p className="text-3xl font-bold text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>{score} / {questions.length}</p>
              <p className="text-muted-foreground text-sm mt-1">{Math.round((score / questions.length) * 100)}% correct</p>
            </div>
            {wrongCards.length > 0 && (
              <div className="w-full">
                <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">Review these:</p>
                <div className="flex flex-col gap-2 max-h-40 overflow-y-auto">
                  {wrongCards.map((q, i) => (
                    <div key={i} className="px-3 py-2 rounded-lg text-xs" style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.15)" }}>
                      <span className="text-red-400 font-medium">{q.question}</span>
                      <span className="text-muted-foreground"> → {q.correctAnswer}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => { setQIndex(0); setSelected(null); setAnswers([]); setWrongCards([]); setPhase("quiz"); }}
                className="px-5 py-2 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90"
                style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}
              >
                Retry
              </button>
              <button onClick={handleRegenerate} className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium text-muted-foreground hover:bg-muted transition-colors border border-border">
                <RefreshCw size={13} /> New Quiz
              </button>
            </div>
          </div>
        )}

        {phase === "idle" && (
          <div className="flex flex-col items-center py-8 gap-4">
            <p className="text-muted-foreground text-sm text-center">Generate a multiple-choice quiz from your deck using Claude AI.</p>
            <button
              onClick={handleGenerate}
              className="flex items-center gap-2 px-6 py-3 rounded-xl font-semibold text-white transition-all hover:opacity-90"
              style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}
            >
              <Sparkles size={16} /> Generate Quiz
            </button>
          </div>
        )}
      </div>
    </ModalBackdrop>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AI CARD MODAL
// ─────────────────────────────────────────────────────────────────────────────
function AiCardModal({
  open, onClose, onGenerate,
}: {
  open: boolean;
  onClose: () => void;
  onGenerate: (prompt: string, count: number) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState(5);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setPrompt("");
      setCount(5);
      setLoading(false);
    }
  }, [open]);

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    setLoading(true);
    try {
      await onGenerate(prompt.trim(), count);
      onClose();
    } catch (err) {
      // Toast / Error is handled inside onGenerate or will bubble up
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalBackdrop open={open} onClose={onClose}>
      <div className="max-w-md mx-auto bg-card border border-border rounded-2xl p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-bold text-lg text-foreground flex items-center gap-2" style={{ fontFamily: "Outfit, sans-serif" }}>
            <Sparkles size={18} className="text-primary" /> AI Card Generator
          </h3>
          <button onClick={onClose} disabled={loading} className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-muted text-muted-foreground">
            <X size={16} />
          </button>
        </div>

        {loading ? (
          <div className="flex flex-col items-center py-12 gap-4">
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
              className="w-10 h-10 rounded-full border-2 border-primary/20 border-t-primary"
            />
            <p className="text-sm text-muted-foreground font-medium">Generating cards with Gemini AI...</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
                Topic or Prompt
              </label>
              <textarea
                placeholder="E.g., 'Spanish colors', 'Python lists and common methods', 'Key dates of World War II'..."
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                rows={3}
                className="w-full px-4 py-3 rounded-xl bg-input-background border border-border text-foreground outline-none focus:ring-2 focus:ring-primary/30 text-sm resize-none"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
                Number of Cards: {count}
              </label>
              <input
                type="range"
                min={3}
                max={15}
                value={count}
                onChange={e => setCount(Number(e.target.value))}
                className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
                <span>3</span>
                <span>5</span>
                <span>10</span>
                <span>15</span>
              </div>
            </div>
            <div className="flex gap-2 mt-2 justify-end">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-xl text-sm font-medium text-muted-foreground hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleGenerate}
                disabled={!prompt.trim()}
                className="px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-40 transition-all hover:opacity-90 flex items-center gap-1.5"
                style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}
              >
                <Sparkles size={14} /> Generate
              </button>
            </div>
          </div>
        )}
      </div>
    </ModalBackdrop>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STUDY SESSION VIEW
// ─────────────────────────────────────────────────────────────────────────────
function StudySessionView({
  phase, studyCards, studyIndex, cardFlipped, setCardFlipped,
  onRate, onEndSession, onStudyAgain, onBackToDashboard,
  completedCount,
}: {
  phase: StudyPhase;
  studyCards: Card[];
  studyIndex: number;
  cardFlipped: boolean;
  setCardFlipped: (v: boolean) => void;
  onRate: (q: number) => void;
  onEndSession: () => void;
  onStudyAgain: () => void;
  onBackToDashboard: () => void;
  completedCount: number;
}) {
  const card = studyCards[studyIndex];
  const progress = studyCards.length > 0 ? (studyIndex / studyCards.length) * 100 : 0;
  const [tilt, setTilt] = useState({ x: 0, y: 0 });

  if (phase === "complete") {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="flex flex-col items-center gap-6 py-12 max-w-md mx-auto text-center"
      >
        <div className="text-6xl">🎉</div>
        <div>
          <h2 className="text-2xl font-bold text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>Session Complete!</h2>
          <p className="text-muted-foreground mt-2">You reviewed {completedCount} cards. Great work!</p>
        </div>
        <div className="grid grid-cols-1 gap-2 w-full">
          <div className="bg-card border border-border rounded-2xl p-4 text-center">
            <div className="text-3xl font-bold text-primary" style={{ fontFamily: "Outfit, sans-serif" }}>{completedCount}</div>
            <div className="text-xs text-muted-foreground mt-1">Cards Reviewed</div>
          </div>
        </div>
        <div className="flex gap-3">
          <button onClick={onStudyAgain} className="px-6 py-3 rounded-xl font-semibold text-white transition-all hover:opacity-90"
            style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}>
            Study Again
          </button>
          <button onClick={onBackToDashboard} className="px-6 py-3 rounded-xl font-medium text-muted-foreground hover:bg-muted border border-border transition-colors">
            Dashboard
          </button>
        </div>
      </motion.div>
    );
  }

  if (!card) return null;

  return (
    <div className="flex flex-col items-center gap-6 max-w-2xl mx-auto py-4">
      {/* Progress */}
      <div className="w-full flex items-center gap-4">
        <div className="flex-1 bg-muted rounded-full h-2">
          <motion.div
            className="h-2 rounded-full"
            style={{ background: "linear-gradient(90deg, #6366f1, #a78bfa)" }}
            animate={{ width: `${progress}%` }}
            transition={{ type: "spring", stiffness: 100 }}
          />
        </div>
        <span className="text-xs text-muted-foreground font-mono">{studyIndex} / {studyCards.length}</span>
      </div>

      {/* 3D Flashcard */}
      <div
        className="w-full max-w-[500px] cursor-pointer select-none h-[220px] sm:h-[280px]"
        style={{ perspective: "1200px" }}
        onMouseMove={e => {
          if (cardFlipped) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const x = (e.clientX - rect.left) / rect.width - 0.5;
          const y = (e.clientY - rect.top) / rect.height - 0.5;
          setTilt({ x: y * -12, y: x * 12 });
        }}
        onMouseLeave={() => setTilt({ x: 0, y: 0 })}
        onClick={() => setCardFlipped(!cardFlipped)}
      >
        <div
          className="relative w-full h-full"
          style={{
            transformStyle: "preserve-3d",
            transition: cardFlipped
              ? "transform 0.6s cubic-bezier(0.4, 0, 0.2, 1)"
              : `transform ${tilt.x === 0 ? "0.4s" : "0.06s"} ease`,
            transform: cardFlipped
              ? "rotateY(180deg)"
              : `perspective(1200px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
          }}
        >
          {/* Front */}
          <div
            className="absolute inset-0 rounded-2xl flex flex-col items-center justify-center p-8 gap-4"
            style={{
              backfaceVisibility: "hidden",
              background: "var(--card)",
              border: "1px solid var(--border)",
              boxShadow: "0 20px 60px rgba(0,0,0,0.15)",
            }}
          >
            <span className="text-xs font-mono text-muted-foreground uppercase tracking-widest px-3 py-1 rounded-lg"
              style={{ background: "var(--muted)" }}>Question</span>
            <p className="text-xl font-semibold text-foreground text-center leading-relaxed" style={{ fontFamily: "Outfit, sans-serif" }}>
              {card.front}
            </p>
            <span className="text-xs text-muted-foreground mt-2">Click to reveal answer</span>
          </div>
          {/* Back */}
          <div
            className="absolute inset-0 rounded-2xl flex flex-col items-center justify-center p-8 gap-4"
            style={{
              backfaceVisibility: "hidden",
              transform: "rotateY(180deg)",
              background: "linear-gradient(135deg, rgba(99,102,241,0.08), rgba(139,92,246,0.05))",
              border: "1px solid rgba(99,102,241,0.25)",
              boxShadow: "0 20px 60px rgba(99,102,241,0.1)",
            }}
          >
            <span className="text-xs font-mono uppercase tracking-widest px-3 py-1 rounded-lg" style={{ background: "rgba(99,102,241,0.12)", color: "#818cf8" }}>Answer</span>
            <p className="text-xl font-semibold text-foreground text-center leading-relaxed" style={{ fontFamily: "Outfit, sans-serif" }}>
              {card.back}
            </p>
          </div>
        </div>
      </div>

      {/* Rating buttons — show only when card is flipped */}
      <AnimatePresence>
        {cardFlipped && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className="flex gap-3 flex-wrap justify-center"
          >
            {[
              { label: "Again", sub: "Reset", quality: 0, color: "#ef4444", bg: "rgba(239,68,68,0.12)", border: "rgba(239,68,68,0.25)" },
              { label: "Hard", sub: "A bit", quality: 2, color: "#f97316", bg: "rgba(249,115,22,0.12)", border: "rgba(249,115,22,0.25)" },
              { label: "Good", sub: "Later", quality: 4, color: "#6366f1", bg: "rgba(99,102,241,0.12)", border: "rgba(99,102,241,0.25)" },
              { label: "Easy", sub: "Spaced", quality: 5, color: "#34d399", bg: "rgba(52,211,153,0.12)", border: "rgba(52,211,153,0.25)" },
            ].map(({ label, sub, quality, color, bg, border }) => (
              <motion.button
                key={label}
                whileHover={{ scale: 1.05, y: -2 }}
                whileTap={{ scale: 0.96 }}
                onClick={() => onRate(quality)}
                className="flex flex-col items-center px-6 py-3 rounded-xl font-semibold text-sm transition-all min-w-[90px]"
                style={{ background: bg, border: `1px solid ${border}`, color }}
              >
                <span>{label}</span>
                <span className="text-xs opacity-60 font-normal mt-0.5">{sub}</span>
              </motion.button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <button onClick={onEndSession} className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5 mt-2">
        <X size={12} /> Exit Session
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  // ── View / Auth state ──────────────────────────────────────────────────────
  const [showApp, setShowApp] = useState(false);
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [authInitialized, setAuthInitialized] = useState(false);
  const [currentView, setCurrentView] = useState<AppView>("dashboard");
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("sx_dark") === "1");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // ── Data state ─────────────────────────────────────────────────────────────
  const [decks, setDecks] = useState<Deck[]>([]);
  const [allCards, setAllCards] = useState<Record<string, Card[]>>({});
  const [activeDeckId, setActiveDeckId] = useState<string | null>(null);

  // ── Study session state ────────────────────────────────────────────────────
  const [studyDeckId, setStudyDeckId] = useState<string | null>(null);
  const [studyCards, setStudyCards] = useState<Card[]>([]);
  const [studyIndex, setStudyIndex] = useState(0);
  const [cardFlipped, setCardFlipped] = useState(false);
  const [studyPhase, setStudyPhase] = useState<StudyPhase>("pick");
  const [completedCount, setCompletedCount] = useState(0);

  // ── Modal state ────────────────────────────────────────────────────────────
  const [deckModal, setDeckModal] = useState<{ open: boolean; editId?: string }>({ open: false });
  const [cardModal, setCardModal] = useState<{ open: boolean; editId?: string; deckId?: string }>({ open: false });
  const [confirmModal, setConfirmModal] = useState<{ open: boolean; message: string; onConfirm: () => void }>({ open: false, message: "", onConfirm: () => { } });
  const [shareModal, setShareModal] = useState<{ open: boolean; deckId?: string }>({ open: false });
  const [quizModal, setQuizModal] = useState<{ open: boolean; deckId?: string }>({ open: false });
  const [aiCardModal, setAiCardModal] = useState<{ open: boolean; deckId?: string }>({ open: false });

  // ── Toast state ────────────────────────────────────────────────────────────
  const [toasts, setToasts] = useState<Toast[]>([]);
  const addToast = useCallback((message: string, type: Toast["type"] = "info") => {
    const id = uid();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3500);
  }, []);
  const removeToast = (id: string) => setToasts(prev => prev.filter(t => t.id !== id));

  // ── Dark mode effect ───────────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
    localStorage.setItem("sx_dark", darkMode ? "1" : "0");
  }, [darkMode]);

  // ── Firebase auth listener ─────────────────────────────────────────────────
  useEffect(() => {
    if (!fbAuth) {
      setAuthInitialized(true);
      return;
    }
    return onAuthStateChanged(fbAuth, async (u) => {
      setUser(u);
      if (u) {
        setShowApp(true);
        try {
          const fsDecks = await storage.fsGetDecks(u.uid);
          const localDecks = storage.localGetDecks();

          if (fsDecks.length > 0) {
            setDecks(fsDecks);
            storage.localSaveDecks(fsDecks);
            const cardsMap: Record<string, Card[]> = {};
            await Promise.all(fsDecks.map(async d => {
              const c = await storage.fsGetCards(d.id);
              cardsMap[d.id] = c;
              storage.localSaveCards(d.id, c);
            }));
            setAllCards(cardsMap);
          } else if (localDecks.length > 0) {
            const updatedDecks = localDecks.map(d => ({ ...d, ownerId: u.uid }));
            setDecks(updatedDecks);
            storage.localSaveDecks(updatedDecks);

            const cardsMap: Record<string, Card[]> = {};
            await Promise.all(updatedDecks.map(async d => {
              await storage.fsSaveDeck(d);
              const c = storage.localGetCards(d.id);
              cardsMap[d.id] = c;
              await Promise.all(c.map(async card => {
                await storage.fsSaveCard(card);
              }));
            }));
            setAllCards(cardsMap);
          }
        } catch (error) {
          console.error("Error syncing Firestore on login:", error);
        }
      }
      setAuthInitialized(true);
    });
  }, []);

  // ── Load local data on mount ───────────────────────────────────────────────
  useEffect(() => {
    const d = storage.localGetDecks();
    setDecks(d);
    const cm: Record<string, Card[]> = {};
    d.forEach(deck => { cm[deck.id] = storage.localGetCards(deck.id); });
    setAllCards(cm);
  }, []);

  // ── Check for share link on load ───────────────────────────────────────────
  useEffect(() => {
    if (!authInitialized) return;
    const params = new URLSearchParams(window.location.search);
    const shareId = params.get("share");
    if (shareId && FIREBASE_READY) {
      storage.fsGetSharedDeck(shareId).then(result => {
        if (result) {
          setShowApp(true);
          const { deck, cards } = result;
          if (!decks.find(d => d.id === deck.id)) {
            const newDecks = [...decks, deck];
            setDecks(newDecks);
            storage.localSaveDecks(newDecks);
            setAllCards(prev => ({ ...prev, [deck.id]: cards }));
            storage.localSaveCards(deck.id, cards);
            addToast(`Deck "${deck.name}" added from shared link!`, "success");
          }
        } else {
          addToast("Shared deck not found or no longer public.", "error");
        }
      });
    }
  }, [authInitialized]);

  // ── Deck CRUD ──────────────────────────────────────────────────────────────
  const saveDeck = async (name: string) => {
    const existing = deckModal.editId ? decks.find(d => d.id === deckModal.editId) : null;
    if (existing) {
      const updated = { ...existing, name, updatedAt: Date.now() };
      const newDecks = decks.map(d => d.id === existing.id ? updated : d);
      setDecks(newDecks);
      storage.localSaveDecks(newDecks);
      if (user) await storage.fsSaveDeck(updated);
      addToast("Deck updated.", "success");
    } else {
      const deck: Deck = { id: uid(), name, ownerId: user?.uid, public: false, createdAt: Date.now() };
      const newDecks = [deck, ...decks];
      setDecks(newDecks);
      storage.localSaveDecks(newDecks);
      setAllCards(prev => ({ ...prev, [deck.id]: [] }));
      if (user) await storage.fsSaveDeck(deck);
      addToast("Deck created!", "success");
    }
    setDeckModal({ open: false });
  };

  const deleteDeck = async (deckId: string) => {
    const newDecks = decks.filter(d => d.id !== deckId);
    setDecks(newDecks);
    storage.localSaveDecks(newDecks);
    localStorage.removeItem(`sx_cards_${deckId}`);
    setAllCards(prev => { const n = { ...prev }; delete n[deckId]; return n; });
    if (user) await storage.fsDeleteDeck(deckId);
    if (activeDeckId === deckId) { setActiveDeckId(null); setCurrentView("decks"); }
    addToast("Deck deleted.", "info");
  };

  const togglePublic = async (deckId: string, pub: boolean) => {
    const deck = decks.find(d => d.id === deckId);
    if (!deck) return;
    const updated = { ...deck, public: pub };
    const newDecks = decks.map(d => d.id === deckId ? updated : d);
    setDecks(newDecks);
    storage.localSaveDecks(newDecks);
    if (user) await storage.fsSaveDeck(updated);
  };

  // ── Card CRUD ──────────────────────────────────────────────────────────────
  const saveCard = async (front: string, back: string) => {
    const deckId = cardModal.deckId ?? activeDeckId ?? "";
    const existing = cardModal.editId ? (allCards[deckId] ?? []).find(c => c.id === cardModal.editId) : null;
    if (existing) {
      const updated = { ...existing, front, back };
      const newCards = (allCards[deckId] ?? []).map(c => c.id === existing.id ? updated : c);
      setAllCards(prev => ({ ...prev, [deckId]: newCards }));
      storage.localSaveCards(deckId, newCards);
      if (user) await storage.fsSaveCard(updated);
      addToast("Card updated.", "success");
    } else {
      const card: Card = {
        id: uid(), deckId, front, back,
        interval: 1, repetitions: 0, easeFactor: 2.5,
        dueDate: Date.now(), createdAt: Date.now()
      };
      const newCards = [...(allCards[deckId] ?? []), card];
      setAllCards(prev => ({ ...prev, [deckId]: newCards }));
      storage.localSaveCards(deckId, newCards);
      if (user) await storage.fsSaveCard(card);
      addToast("Card added!", "success");
    }
    setCardModal({ open: false });
  };

  const deleteCard = async (cardId: string, deckId: string) => {
    const newCards = (allCards[deckId] ?? []).filter(c => c.id !== cardId);
    setAllCards(prev => ({ ...prev, [deckId]: newCards }));
    storage.localSaveCards(deckId, newCards);
    if (user) await storage.fsDeleteCard(cardId);
    addToast("Card deleted.", "info");
  };

  const handleGenerateCards = async (prompt: string, count: number) => {
    const deckId = activeDeckId;
    if (!deckId) return;
    try {
      const generated = await generateCards(prompt, count);
      
      const newCardsList: Card[] = generated.map(gc => ({
        id: uid(),
        deckId,
        front: gc.front,
        back: gc.back,
        interval: 1,
        repetitions: 0,
        easeFactor: 2.5,
        dueDate: Date.now(),
        createdAt: Date.now()
      }));

      const existingCards = allCards[deckId] ?? [];
      const updatedCards = [...existingCards, ...newCardsList];

      setAllCards(prev => ({ ...prev, [deckId]: updatedCards }));
      storage.localSaveCards(deckId, updatedCards);

      if (user) {
        await Promise.all(newCardsList.map(async card => {
          await storage.fsSaveCard(card);
        }));
      }

      addToast(`Successfully generated ${count} cards!`, "success");
    } catch (err: any) {
      console.error(err);
      addToast(err?.message || "Failed to generate cards. Please check your API key.", "error");
      throw err;
    }
  };

  // ── Study session ──────────────────────────────────────────────────────────
  const startStudy = (deckId: string) => {
    const due = (allCards[deckId] ?? []).filter(c => c.dueDate <= Date.now());
    if (due.length === 0) { addToast("No cards due! Come back later.", "info"); return; }
    setStudyDeckId(deckId);
    setStudyCards(due);
    setStudyIndex(0);
    setCardFlipped(false);
    setStudyPhase("session");
    setCompletedCount(0);
    setCurrentView("study");
  };

  const rateCard = async (quality: number) => {
    const card = studyCards[studyIndex];
    if (!card) return;
    const { interval, repetitions, easeFactor } = sm2(quality, card.repetitions, card.easeFactor, card.interval);
    const updated = {
      ...card,
      interval, repetitions, easeFactor,
      dueDate: Date.now() + interval * 86400000
    };
    const deckCards = (allCards[card.deckId] ?? []).map(c => c.id === card.id ? updated : c);
    setAllCards(prev => ({ ...prev, [card.deckId]: deckCards }));
    storage.localSaveCards(card.deckId, deckCards);
    if (user) await storage.fsSaveCard(updated);

    const nextIndex = studyIndex + 1;
    setCompletedCount(c => c + 1);
    if (nextIndex >= studyCards.length) {
      setStudyPhase("complete");
    } else {
      setStudyIndex(nextIndex);
      setCardFlipped(false);
    }
  };

  // ── Import / Export ────────────────────────────────────────────────────────
  const exportData = () => {
    const data = { decks, cards: allCards, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "simplex-backup.json"; a.click();
    URL.revokeObjectURL(url);
    addToast("Data exported!", "success");
  };

  const importData = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (data.decks && data.cards) {
          setDecks(data.decks);
          storage.localSaveDecks(data.decks);
          setAllCards(data.cards);
          Object.keys(data.cards).forEach(deckId => storage.localSaveCards(deckId, data.cards[deckId]));
          addToast("Data imported!", "success");
        }
      } catch { addToast("Invalid file format.", "error"); }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  // ── Computed stats ─────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const totalCards = Object.values(allCards).reduce((sum, c) => sum + c.length, 0);
    const dueToday = Object.values(allCards).reduce((sum, c) => sum + c.filter(x => x.dueDate <= Date.now()).length, 0);
    const studied = Object.values(allCards).reduce((sum, c) => sum + c.filter(x => x.repetitions > 0).length, 0);
    const retention = totalCards > 0 ? Math.round((studied / totalCards) * 100) : 0;
    return { totalDecks: decks.length, totalCards, dueToday, retention };
  }, [decks, allCards]);

  const editingDeck = deckModal.editId ? decks.find(d => d.id === deckModal.editId) : undefined;
  const editingCard = cardModal.editId ? (allCards[cardModal.deckId ?? ""] ?? []).find(c => c.id === cardModal.editId) : undefined;
  const activeDeck = activeDeckId ? decks.find(d => d.id === activeDeckId) : undefined;
  const activeCards = activeDeckId ? (allCards[activeDeckId] ?? []) : [];
  const shareDeck = shareModal.deckId ? decks.find(d => d.id === shareModal.deckId) : undefined;
  const quizDeck = quizModal.deckId ? decks.find(d => d.id === quizModal.deckId) : undefined;
  const quizCards = quizModal.deckId ? (allCards[quizModal.deckId] ?? []) : [];

  const navItems: { view: AppView; icon: React.ReactNode; label: string }[] = [
    { view: "dashboard", icon: <LayoutDashboard size={18} />, label: "Dashboard" },
    { view: "decks", icon: <BookOpen size={18} />, label: "My Decks" },
    { view: "study", icon: <Brain size={18} />, label: "Study" },
  ];

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-[100dvh] bg-background text-foreground" style={{ fontFamily: "Inter, sans-serif" }}>
      <AnimatePresence mode="wait">
        {!showApp ? (
          <motion.div key="hero" exit={{ opacity: 0, y: -30 }} transition={{ duration: 0.5 }}>
            <HeroSection
              onEnterApp={() => setShowApp(true)}
              onAuthSuccess={u => setUser(u)}
              addToast={addToast}
            />
          </motion.div>
        ) : (
          <motion.div
            key="app"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            className="flex h-[100dvh] min-h-[100dvh] overflow-hidden"
          >
            {/* Sidebar overlay (mobile) */}
            {sidebarOpen && (
              <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={() => setSidebarOpen(false)} />
            )}

            {/* Sidebar */}
            <aside
              className={`fixed lg:relative z-50 lg:z-auto inset-y-0 lg:h-full left-0 w-64 flex-shrink-0 flex flex-col border-r border-sidebar-border transition-transform duration-300 ${sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}`}
              style={{ background: "var(--sidebar)" }}
            >
              {/* Logo */}
              <div className="flex items-center gap-3 px-5 py-5 border-b border-sidebar-border">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: "linear-gradient(135deg, #6366f1, #a78bfa)" }}>
                  <Brain size={18} className="text-white" />
                </div>
                <div>
                  <div className="font-bold text-sidebar-foreground leading-tight" style={{ fontFamily: "Outfit, sans-serif" }}>Simplex</div>
                  <div className="text-xs text-muted-foreground">Spaced Repetition</div>
                </div>
              </div>

              {/* Nav */}
              <nav className="flex-1 px-3 py-4 flex flex-col gap-1">
                {navItems.map(item => (
                  <button
                    key={item.view}
                    onClick={() => {
                      if (item.view === "study") setStudyPhase("pick");
                      setCurrentView(item.view);
                      setSidebarOpen(false);
                    }}
                    className={`flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${currentView === item.view || (currentView === "deck-detail" && item.view === "decks")
                      ? "text-sidebar-primary-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent/50"
                      }`}
                    style={
                      currentView === item.view || (currentView === "deck-detail" && item.view === "decks")
                        ? { background: "linear-gradient(135deg, rgba(99,102,241,0.2), rgba(139,92,246,0.15))", color: "var(--sidebar-primary)" }
                        : {}
                    }
                  >
                    {item.icon}
                    <span>{item.label}</span>
                    {item.view === "study" && stats.dueToday > 0 && (
                      <span className="ml-auto text-xs font-bold px-2 py-0.5 rounded-full text-white"
                        style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}>
                        {stats.dueToday}
                      </span>
                    )}
                  </button>
                ))}
              </nav>

              {/* Footer */}
              <div className="px-3 pb-4 pt-3 border-t border-sidebar-border flex flex-col gap-2">
                {user && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs text-sidebar-foreground/70 truncate">
                    <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-white text-[10px] font-bold"
                      style={{ background: "linear-gradient(135deg, #6366f1, #a78bfa)" }}>
                      {user.email?.[0]?.toUpperCase() ?? "U"}
                    </div>
                    <span className="truncate">{user.email}</span>
                  </div>
                )}

                <button
                  onClick={() => setDarkMode(d => !d)}
                  className="flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors"
                >
                  {darkMode ? <Sun size={16} /> : <Moon size={16} />}
                  {darkMode ? "Light Mode" : "Dark Mode"}
                </button>

                {user && fbAuth && (
                  <button
                    onClick={async () => {
                      await firebaseSignOut(fbAuth);
                      setUser(null);
                      setShowApp(false);
                      setCurrentView("dashboard");
                      // Reload guest local data
                      const d = storage.localGetDecks();
                      setDecks(d);
                      const cm: Record<string, Card[]> = {};
                      d.forEach(deck => { cm[deck.id] = storage.localGetCards(deck.id); });
                      setAllCards(cm);
                      addToast("Signed out.", "info");
                    }}
                    className="flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors"
                  >
                    <LogOut size={16} /> Log Out
                  </button>
                )}

                <div className="flex gap-2">
                  <button onClick={exportData} className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:bg-muted transition-colors border border-border">
                    <Download size={12} /> Export
                  </button>
                  <label className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:bg-muted transition-colors border border-border cursor-pointer">
                    <Upload size={12} /> Import
                    <input type="file" accept=".json" className="hidden" onChange={importData} />
                  </label>
                </div>
              </div>
            </aside>

            {/* Main content */}
            <div className="flex-1 flex flex-col overflow-hidden min-w-0">
              {/* Top bar */}
              <header className="flex items-center justify-between px-6 py-4 border-b border-border bg-background/80 backdrop-blur-sm flex-shrink-0">
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setSidebarOpen(v => !v)}
                    className="lg:hidden w-8 h-8 rounded-lg flex items-center justify-center hover:bg-muted text-muted-foreground"
                  >
                    <Menu size={18} />
                  </button>
                  <h1 className="font-bold text-xl text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
                    {currentView === "dashboard" ? "Dashboard"
                      : currentView === "decks" ? "My Decks"
                        : currentView === "study" ? "Study"
                          : activeDeck?.name ?? "Deck Detail"}
                  </h1>
                </div>
                <div className="flex items-center gap-2">
                  {(currentView === "dashboard" || currentView === "decks") && (
                    <button
                      onClick={() => setDeckModal({ open: true })}
                      className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-95"
                      style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}
                    >
                      <Plus size={16} /> New Deck
                    </button>
                  )}
                  {currentView === "deck-detail" && activeDeckId && (
                    <div className="flex gap-1.5 sm:gap-2">
                      <button
                        onClick={() => startStudy(activeDeckId)}
                        title="Study Now"
                        className="flex items-center gap-1.5 px-2.5 py-2 sm:px-4 sm:py-2 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90"
                        style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}
                      >
                        <Brain size={15} />
                        <span className="hidden sm:inline">Study Now</span>
                      </button>
                      <button
                        onClick={() => setQuizModal({ open: true, deckId: activeDeckId })}
                        title="Generate Quiz"
                        className="flex items-center gap-1.5 px-2.5 py-2 sm:px-4 sm:py-2 rounded-xl text-sm font-semibold border border-border text-foreground hover:bg-muted transition-colors"
                      >
                        <ClipboardList size={15} />
                        <span className="hidden sm:inline">Generate Quiz</span>
                      </button>
                      <button
                        onClick={() => setAiCardModal({ open: true, deckId: activeDeckId })}
                        title="AI Generate"
                        className="flex items-center gap-1.5 px-2.5 py-2 sm:px-4 sm:py-2 rounded-xl text-sm font-semibold border border-primary/40 text-primary hover:bg-primary/5 transition-colors"
                      >
                        <Sparkles size={15} />
                        <span className="hidden sm:inline">AI Generate</span>
                      </button>
                      <button
                        onClick={() => setCardModal({ open: true, deckId: activeDeckId })}
                        title="Add Card"
                        className="flex items-center gap-1.5 px-2.5 py-2 sm:px-4 sm:py-2 rounded-xl text-sm font-medium border border-border text-foreground hover:bg-muted transition-colors"
                      >
                        <Plus size={15} />
                        <span className="hidden sm:inline">Add Card</span>
                      </button>
                    </div>
                  )}
                </div>
              </header>

              {/* Page content */}
              <main className="flex-1 overflow-y-auto p-6">
                <AnimatePresence mode="wait">
                  {/* ── DASHBOARD ── */}
                  {currentView === "dashboard" && (
                    <motion.div key="dashboard" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
                      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
                        <StatCard icon={<BookOpen size={18} />} value={stats.totalDecks} label="Total Decks" />
                        <StatCard icon={<FlipHorizontal size={18} />} value={stats.totalCards} label="Total Cards" />
                        <StatCard icon={<Zap size={18} />} value={stats.dueToday} label="Due Today" accent />
                        <StatCard icon={<CheckCircle size={18} />} value={`${stats.retention}%`} label="Retention Rate" />
                      </div>

                      <div className="flex items-center justify-between mb-4">
                        <h2 className="font-bold text-foreground text-lg" style={{ fontFamily: "Outfit, sans-serif" }}>Recent Decks</h2>
                        <button onClick={() => setCurrentView("decks")} className="text-sm text-primary hover:text-primary/80 flex items-center gap-1 transition-colors">
                          View All <ChevronRight size={14} />
                        </button>
                      </div>

                      {decks.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
                          <div className="w-16 h-16 rounded-2xl flex items-center justify-center" style={{ background: "linear-gradient(135deg, rgba(99,102,241,0.15), rgba(139,92,246,0.1))" }}>
                            <BookOpen size={28} className="text-primary/60" />
                          </div>
                          <div>
                            <p className="font-semibold text-foreground">No decks yet</p>
                            <p className="text-sm text-muted-foreground mt-1">Create your first deck to start studying</p>
                          </div>
                          <button onClick={() => setDeckModal({ open: true })} className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white" style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}>
                            <Plus size={14} className="inline mr-1.5" /> Create Deck
                          </button>
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                          {decks.slice(0, 6).map(deck => (
                            <DeckCard
                              key={deck.id}
                              deck={deck}
                              cards={allCards[deck.id] ?? []}
                              onStudy={() => startStudy(deck.id)}
                              onOpen={() => { setActiveDeckId(deck.id); setCurrentView("deck-detail"); }}
                              onEdit={() => setDeckModal({ open: true, editId: deck.id })}
                              onDelete={() => setConfirmModal({ open: true, message: `Delete "${deck.name}" and all its cards?`, onConfirm: () => deleteDeck(deck.id) })}
                              onShare={() => setShareModal({ open: true, deckId: deck.id })}
                            />
                          ))}
                        </div>
                      )}
                    </motion.div>
                  )}

                  {/* ── MY DECKS ── */}
                  {currentView === "decks" && (
                    <motion.div key="decks" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
                      {decks.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
                          <div className="w-16 h-16 rounded-2xl flex items-center justify-center" style={{ background: "rgba(99,102,241,0.12)" }}>
                            <BookOpen size={28} className="text-primary/60" />
                          </div>
                          <p className="font-semibold text-foreground">No decks yet</p>
                          <button onClick={() => setDeckModal({ open: true })} className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white" style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}>
                            Create First Deck
                          </button>
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                          {decks.map(deck => (
                            <DeckCard
                              key={deck.id}
                              deck={deck}
                              cards={allCards[deck.id] ?? []}
                              onStudy={() => startStudy(deck.id)}
                              onOpen={() => { setActiveDeckId(deck.id); setCurrentView("deck-detail"); }}
                              onEdit={() => setDeckModal({ open: true, editId: deck.id })}
                              onDelete={() => setConfirmModal({ open: true, message: `Delete "${deck.name}" and all its cards?`, onConfirm: () => deleteDeck(deck.id) })}
                              onShare={() => setShareModal({ open: true, deckId: deck.id })}
                            />
                          ))}
                        </div>
                      )}
                    </motion.div>
                  )}

                  {/* ── STUDY ── */}
                  {currentView === "study" && (
                    <motion.div key="study" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
                      {studyPhase === "pick" && (
                        <div>
                          <p className="text-sm text-muted-foreground mb-5">Choose a deck to study.</p>
                          {decks.length === 0 ? (
                            <p className="text-muted-foreground text-sm">No decks available. Create one first!</p>
                          ) : (
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                              {decks.map(deck => (
                                <DeckCard
                                  key={deck.id}
                                  deck={deck}
                                  cards={allCards[deck.id] ?? []}
                                  onStudy={() => startStudy(deck.id)}
                                  onOpen={() => startStudy(deck.id)}
                                  onEdit={() => setDeckModal({ open: true, editId: deck.id })}
                                  onDelete={() => setConfirmModal({ open: true, message: `Delete "${deck.name}"?`, onConfirm: () => deleteDeck(deck.id) })}
                                  onShare={() => setShareModal({ open: true, deckId: deck.id })}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {(studyPhase === "session" || studyPhase === "complete") && (
                        <StudySessionView
                          phase={studyPhase}
                          studyCards={studyCards}
                          studyIndex={studyIndex}
                          cardFlipped={cardFlipped}
                          setCardFlipped={setCardFlipped}
                          onRate={rateCard}
                          onEndSession={() => setStudyPhase("pick")}
                          onStudyAgain={() => {
                            const due = (allCards[studyDeckId ?? ""] ?? []).filter(c => c.dueDate <= Date.now());
                            if (due.length === 0) { addToast("No more due cards right now.", "info"); setStudyPhase("pick"); return; }
                            setStudyCards(due);
                            setStudyIndex(0);
                            setCardFlipped(false);
                            setStudyPhase("session");
                            setCompletedCount(0);
                          }}
                          onBackToDashboard={() => { setCurrentView("dashboard"); setStudyPhase("pick"); }}
                          completedCount={completedCount}
                        />
                      )}
                    </motion.div>
                  )}

                  {/* ── DECK DETAIL ── */}
                  {currentView === "deck-detail" && activeDeck && (
                    <motion.div key="deck-detail" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
                      <button
                        onClick={() => { setCurrentView("decks"); setActiveDeckId(null); }}
                        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-5"
                      >
                        <ArrowLeft size={14} /> Back to Decks
                      </button>

                      {activeCards.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
                          <div className="w-16 h-16 rounded-2xl flex items-center justify-center" style={{ background: "rgba(99,102,241,0.12)" }}>
                            <FlipHorizontal size={28} className="text-primary/60" />
                          </div>
                          <p className="font-semibold text-foreground">No cards in this deck</p>
                          <div className="flex gap-2.5 justify-center">
                            <button onClick={() => setCardModal({ open: true, deckId: activeDeckId ?? "" })} className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-95" style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}>
                              Add First Card
                            </button>
                            <button onClick={() => setAiCardModal({ open: true, deckId: activeDeckId ?? "" })} className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold border border-primary/40 text-primary hover:bg-primary/5 transition-colors">
                              <Sparkles size={15} /> Generate with AI
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          {activeCards.map(card => (
                            <motion.div
                              key={card.id}
                              whileHover={{ y: -2 }}
                              transition={{ type: "spring", stiffness: 300 }}
                              className="bg-card border border-border rounded-xl p-4 flex gap-4 group"
                            >
                              <div className="flex-1 grid grid-cols-2 gap-3 min-w-0">
                                <div>
                                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">Front</p>
                                  <p className="text-sm text-foreground line-clamp-3">{card.front}</p>
                                </div>
                                <div>
                                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">Back</p>
                                  <p className="text-sm text-foreground line-clamp-3">{card.back}</p>
                                </div>
                              </div>
                              <div className="flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                  onClick={() => setCardModal({ open: true, editId: card.id, deckId: card.deckId })}
                                  className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                                >
                                  <Edit3 size={13} />
                                </button>
                                <button
                                  onClick={() => setConfirmModal({ open: true, message: "Delete this card?", onConfirm: () => deleteCard(card.id, card.deckId) })}
                                  className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            </motion.div>
                          ))}
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </main>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── MODALS ── */}
      <DeckModal
        open={deckModal.open}
        onClose={() => setDeckModal({ open: false })}
        onSave={saveDeck}
        initialName={editingDeck?.name}
      />
      <CardModal
        open={cardModal.open}
        onClose={() => setCardModal({ open: false })}
        onSave={saveCard}
        initialFront={editingCard?.front}
        initialBack={editingCard?.back}
      />
      <ConfirmModal
        open={confirmModal.open}
        onClose={() => setConfirmModal(s => ({ ...s, open: false }))}
        onConfirm={confirmModal.onConfirm}
        message={confirmModal.message}
      />
      <ShareModal
        open={shareModal.open}
        onClose={() => setShareModal({ open: false })}
        deck={shareDeck}
        onTogglePublic={togglePublic}
        addToast={addToast}
      />
      <QuizModal
        open={quizModal.open}
        onClose={() => setQuizModal({ open: false })}
        deck={quizDeck}
        cards={quizCards}
        addToast={addToast}
      />
      <AiCardModal
        open={aiCardModal.open}
        onClose={() => setAiCardModal({ open: false })}
        onGenerate={handleGenerateCards}
      />

      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </div>
  );
}
