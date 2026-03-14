import { useState, useEffect, useRef, useMemo, useCallback } from "react";

// ═══ SECURITY + SYNC LAYER ═══
const Crypto = {
  async deriveKey(pin, salt) { const e = new TextEncoder(); const km = await crypto.subtle.importKey("raw", e.encode(pin), "PBKDF2", false, ["deriveKey"]); return crypto.subtle.deriveKey({ name: "PBKDF2", salt: e.encode(salt), iterations: 310000, hash: "SHA-256" }, km, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]); },
  async encrypt(data, key) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(data))); return { iv: [...iv], data: [...new Uint8Array(ct)] }; },
  async decrypt(obj, key) { try { return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(obj.iv) }, key, new Uint8Array(obj.data)))); } catch { return null; } },
  async hmac(data, secret) { const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(JSON.stringify(data))); return [...new Uint8Array(s)].map(b => b.toString(16).padStart(2, "0")).join(""); },
  salt() { return [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join(""); },
  async hash(pin, salt) { const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pin + salt)); return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join(""); },
};
const S = {
  txt: (s, m = 100) => typeof s !== "string" ? "" : s.replace(/[<>"'`&\\]/g, "").replace(/javascript:/gi, "").replace(/on\w+\s*=/gi, "").replace(/\0/g, "").trim().slice(0, m),
  num: (s, lo = 0, hi = 9999999) => { const n = parseFloat(s); return isNaN(n) || !isFinite(n) ? null : Math.max(lo, Math.min(hi, Math.round(n * 100) / 100)); },
  cat: s => ["food", "transport", "shopping", "entertainment", "bills", "other"].includes(s) ? s : "other",
  payer: s => s === 0 || s === 1 ? s : 0,
  pay: s => s === "credit" ? "credit" : "cash",
  img: s => { if (!s || typeof s !== "string") return null; if (!["data:image/jpeg", "data:image/png", "data:image/webp", "data:image/gif"].some(p => s.startsWith(p))) return null; return s.length > 5e6 * 1.37 ? null : s; },
};
class RL { constructor(mx, ms) { this.mx = mx; this.ms = ms; this.a = []; } ok() { this.a = this.a.filter(t => Date.now() - t < this.ms); return this.a.length < this.mx; } rec() { this.a.push(Date.now()); } left() { if (this.ok()) return 0; return Math.ceil((this.ms - (Date.now() - this.a[this.a.length - this.mx])) / 1000); } }
const Log = { _l: [], log(e, d = "", s = "info") { this._l.unshift({ ts: new Date().toISOString(), e, d: S.txt(String(d), 200), s }); if (this._l.length > 200) this._l.pop(); }, sec() { return this._l.filter(l => l.s !== "info"); } };

const CATS = [{ id: "food", l: "อาหาร", e: "🍜" }, { id: "transport", l: "เดินทาง", e: "🚗" }, { id: "shopping", l: "ช้อปปิ้ง", e: "🛍️" }, { id: "entertainment", l: "เที่ยว/บันเทิง", e: "🎬" }, { id: "bills", l: "ค่าบิล", e: "📄" }, { id: "other", l: "อื่นๆ", e: "💫" }];
const TIMEOUT = 5 * 60 * 1000, PINLEN = 4, MAX_PIN = 5, LOCK_MS = 5 * 60 * 1000, MAX_TX = 500, MAX_IMG = 3, SYNC_MS = 5000;
const INIT_DATA = { names: ["ฉัน", "แฟน"], transactions: [], nextId: 1, creditDueDay: 25 };

const sGet = async k => { try { const v = localStorage.getItem('cet_' + k); return v ?? null; } catch { return null; } };
const sSet = async (k, v) => { try { localStorage.setItem('cet_' + k, v); } catch {} };

const Hearts = () => {
  const h = useMemo(() => Array.from({ length: 6 }, (_, i) => ({ i, l: Math.random() * 100, dl: Math.random() * 6, sz: 10 + Math.random() * 14, dr: 8 + Math.random() * 6, op: .06 + Math.random() * .1 })), []);
  return <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0, overflow: "hidden" }}>{h.map(x => <div key={x.i} style={{ position: "absolute", left: `${x.l}%`, bottom: -30, fontSize: x.sz, opacity: x.op, animation: `floatUp ${x.dr}s ${x.dl}s ease-in infinite` }}>💕</div>)}</div>;
};

// ═══ PIN SCREEN (with built-in PIN recovery) ═══
function PinScreen({ mode, onOk, onSetup, lock, onRecovered, onReset }) {
  const [p, setP] = useState(""); const [c, setC] = useState(""); const [step, setStep] = useState(mode === "setup" ? "create" : "enter");
  const [err, setErr] = useState(""); const [shake, setShake] = useState(false);
  // Recovery
  const [showRecovery, setShowRecovery] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recPct, setRecPct] = useState(0);
  const [recResult, setRecResult] = useState(null); // { pin, data } | "fail"
  const [showConfirmReset, setShowConfirmReset] = useState(false);
  const cancelRef = useRef(false);

  const F = `'Sarabun','Noto Sans Thai',sans-serif`, pk = "#e8628c", pkd = "#c2185b", pkl = "#fce4ec", pks = "#f8bbd0";
  const go = n => { if (lock > 0) return; const cur = step === "confirm" ? c : p; if (cur.length >= PINLEN) return; const nx = cur + n;
    if (step === "confirm") { setC(nx); if (nx.length === PINLEN) { if (nx === p) onSetup(nx); else { setErr("PIN ไม่ตรงกัน"); setC(""); setShake(true); setTimeout(() => setShake(false), 500); } } }
    else if (step === "create") { setP(nx); if (nx.length === PINLEN) { setStep("confirm"); setErr(""); } }
    else { setP(nx); if (nx.length === PINLEN) { onOk(nx); setP(""); } }
  };
  const del = () => step === "confirm" ? setC(x => x.slice(0, -1)) : setP(x => x.slice(0, -1));
  useEffect(() => { if (mode === "enter") { setP(""); setStep("enter"); } }, [mode]);

  const startRecovery = async () => {
    setRecovering(true); setRecPct(0); setRecResult(null); cancelRef.current = false;
    try {
      const salt = await sGet("pin_salt"); const storedHash = await sGet("pin_hash"); const encStr = await sGet("app_data");
      if (!salt || !storedHash || !encStr) { setRecResult("fail"); setRecovering(false); return; }
      const encData = JSON.parse(encStr);
      for (let i = 0; i <= 9999; i++) {
        if (cancelRef.current) { setRecovering(false); return; }
        const pin = String(i).padStart(4, "0");
        try {
          const ph = await Crypto.hash(pin, salt);
          if (ph === storedHash) {
            const key = await Crypto.deriveKey(pin, salt);
            const dec = await Crypto.decrypt(encData, key);
            if (dec) { setRecResult({ pin, data: dec }); setRecovering(false); return; }
          }
        } catch {}
        if (i % 50 === 0) { setRecPct(Math.round((i / 10000) * 100)); await new Promise(r => setTimeout(r, 0)); }
      }
      setRecResult("fail"); setRecovering(false);
    } catch { setRecResult("fail"); setRecovering(false); }
  };

  const cur = step === "confirm" ? c : p;
  const title = step === "create" ? "🔒 ตั้ง PIN ใหม่" : step === "confirm" ? "🔒 ยืนยัน PIN" : "🔒 ใส่ PIN เพื่อเข้าใช้";
  const sub = step === "create" ? "ตั้งรหัส 4 หลักเพื่อปกป้องข้อมูล" : step === "confirm" ? "กรอก PIN อีกครั้ง" : lock > 0 ? `ถูกล็อก — รอ ${lock} วินาที` : "กรอกรหัส 4 หลัก";

  const bst = p => ({ width: "100%", padding: "14px", borderRadius: 14, border: p ? "none" : `2px solid ${pks}`, background: p ? `linear-gradient(135deg,${pk},${pkd})` : "white", color: p ? "white" : pk, fontWeight: 700, fontSize: 15, cursor: "pointer", fontFamily: F, marginBottom: 10, boxShadow: p ? "0 4px 16px rgba(232,98,140,.25)" : "none" });

  // ── Recovery Found Screen ──
  if (recResult && recResult !== "fail") {
    const d = recResult.data, names = d.names || ["ฉัน", "แฟน"];
    const txs = d.transactions || [];
    const pending = txs.filter(t => !t.settled);
    let cashBal = 0, creditBal = 0;
    pending.forEach(t => { const a = t.split ? t.amount / 2 : t.amount; const isCash = (t.payMethod || "cash") === "cash"; t.payer === 0 ? (isCash ? cashBal += a : creditBal += a) : (isCash ? cashBal -= a : creditBal -= a); });
    const fmt = n => Math.abs(n).toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    const catE = { food: "🍜", transport: "🚗", shopping: "🛍️", entertainment: "🎬", bills: "📄", other: "💫" };
    return (
      <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,#fff0f3,#ffe0ec,#fce4ec)", fontFamily: F, padding: 20 }}>
        <link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;600;700;800&display=swap" rel="stylesheet" />
        <div style={{ maxWidth: 400, margin: "0 auto" }}>
          <div style={{ background: "rgba(255,255,255,.92)", borderRadius: 24, padding: "28px 24px", textAlign: "center", boxShadow: "0 8px 40px rgba(232,98,140,.15)", marginBottom: 16 }}>
            <div style={{ fontSize: 48, marginBottom: 8 }}>🎉</div>
            <h2 style={{ color: pkd, fontWeight: 800, fontSize: 20, margin: "0 0 6px" }}>กู้ข้อมูลสำเร็จ!</h2>
            <p style={{ color: "#b0728a", fontSize: 13, margin: "0 0 16px" }}>จดรหัส PIN แล้วกดเข้าใช้งานได้เลย</p>
            <div style={{ background: pkl, borderRadius: 14, padding: "12px 20px", marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: "#b0728a" }}>PIN ของคุณคือ</div>
              <div style={{ fontSize: 36, fontWeight: 800, color: pkd, letterSpacing: 8 }}>{recResult.pin}</div>
            </div>
            <button onClick={() => onRecovered(recResult.pin, recResult.data)} style={bst(true)}>🔓 เข้าใช้งานเลย</button>
          </div>

          {/* Summary */}
          <div style={{ background: "rgba(255,255,255,.92)", borderRadius: 20, padding: "20px", boxShadow: "0 4px 24px rgba(232,98,140,.1)", marginBottom: 16 }}>
            <h3 style={{ color: pkd, fontSize: 15, fontWeight: 800, margin: "0 0 12px" }}>📊 สรุปยอดค้าง</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div style={{ textAlign: "center", padding: 12, background: pkl, borderRadius: 12 }}>
                <div style={{ fontSize: 11, color: "#b0728a" }}>💵 เงินสด</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: pkd }}>฿{fmt(cashBal)}</div>
              </div>
              <div style={{ textAlign: "center", padding: 12, background: "#e3f2fd", borderRadius: 12 }}>
                <div style={{ fontSize: 11, color: "#5c6bc0" }}>💳 บัตรเครดิต</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: "#1565c0" }}>฿{fmt(creditBal)}</div>
              </div>
            </div>
            <p style={{ textAlign: "center", fontSize: 12, color: "#b0728a", marginTop: 10 }}>
              {pending.length} รายการค้าง • {txs.filter(t => t.settled).length} เคลียร์แล้ว
            </p>
          </div>

          {/* Pending transactions */}
          {pending.length > 0 && <div style={{ background: "rgba(255,255,255,.92)", borderRadius: 20, padding: "20px", boxShadow: "0 4px 24px rgba(232,98,140,.1)" }}>
            <h3 style={{ color: pkd, fontSize: 15, fontWeight: 800, margin: "0 0 12px" }}>📋 รายการค้างจ่าย ({pending.length})</h3>
            {pending.map((t, i) => { const isCc = t.payMethod === "credit"; return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: i < pending.length - 1 ? "1px solid rgba(232,98,140,.08)" : "none" }}>
                <div style={{ fontSize: 18 }}>{catE[t.category] || "💫"}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 12, color: "#4a2036" }}>{t.note} <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 4, background: isCc ? "#e3f2fd" : "#fff8e1", color: isCc ? "#1565c0" : "#f57f17" }}>{isCc ? "💳" : "💵"}</span></div>
                  <div style={{ fontSize: 10, color: "#b0728a" }}>{names[t.payer]} • {new Date(t.date).toLocaleDateString("th-TH", { day: "numeric", month: "short" })}</div>
                </div>
                <div style={{ fontWeight: 800, fontSize: 14, color: isCc ? "#1565c0" : pkd }}>฿{fmt(t.split ? t.amount / 2 : t.amount)}</div>
              </div>
            ); })}
          </div>}
        </div>
      </div>
    );
  }

  // ── Recovery Screen ──
  if (showRecovery) return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,#fff0f3,#ffe0ec,#fce4ec)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: F, padding: 20 }}>
      <link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;600;700;800&display=swap" rel="stylesheet" /><Hearts />
      <div style={{ textAlign: "center", zIndex: 1, background: "rgba(255,255,255,.92)", borderRadius: 24, padding: "32px 28px", maxWidth: 340, width: "100%", boxShadow: "0 12px 48px rgba(232,98,140,.2)" }}>
        {recovering ? (<>
          <div style={{ fontSize: 40, marginBottom: 10 }}>🔍</div>
          <h2 style={{ color: pkd, fontWeight: 800, fontSize: 18, margin: "0 0 8px" }}>กำลังค้นหา PIN...</h2>
          <p style={{ color: "#b0728a", fontSize: 12, margin: "0 0 16px" }}>กรุณารอสักครู่ ไม่เกิน 1 นาที</p>
          <div style={{ height: 10, background: pkl, borderRadius: 5, overflow: "hidden", marginBottom: 8 }}>
            <div style={{ height: "100%", width: `${recPct}%`, background: `linear-gradient(90deg,${pk},${pkd})`, borderRadius: 5, transition: "width .3s" }} />
          </div>
          <p style={{ color: "#cca0b3", fontSize: 12 }}>{recPct}% — กำลังลอง PIN ทั้งหมด 10,000 แบบ</p>
          <button onClick={() => { cancelRef.current = true; setShowRecovery(false); setRecovering(false); }} style={{ ...bst(false), marginTop: 16 }}>ยกเลิก</button>
        </>) : recResult === "fail" ? (<>
          <div style={{ fontSize: 40, marginBottom: 10 }}>😢</div>
          <h2 style={{ color: pkd, fontWeight: 800, fontSize: 18, margin: "0 0 8px" }}>ไม่สามารถกู้ข้อมูลได้</h2>
          <p style={{ color: "#b0728a", fontSize: 12, margin: "0 0 16px" }}>ข้อมูลอาจเสียหายหรือถูกลบ</p>
          {!showConfirmReset ? (
            <button onClick={() => setShowConfirmReset(true)} style={bst(false)}>🗑️ รีเซ็ตแล้วเริ่มใหม่</button>
          ) : (<>
            <div style={{ background: "#fff3e0", borderRadius: 12, padding: "12px 16px", fontSize: 13, color: "#e65100", marginBottom: 12 }}>⚠️ ข้อมูลทั้งหมดจะหายไป แน่ใจหรือไม่?</div>
            <button onClick={() => { onReset(); }} style={{ ...bst(true), background: "linear-gradient(135deg,#e53935,#c62828)" }}>ยืนยันรีเซ็ต</button>
          </>)}
          <button onClick={() => { setShowRecovery(false); setRecResult(null); }} style={{ ...bst(false), marginTop: 4 }}>← กลับ</button>
        </>) : (<>
          <div style={{ fontSize: 40, marginBottom: 10 }}>🔓</div>
          <h2 style={{ color: pkd, fontWeight: 800, fontSize: 18, margin: "0 0 8px" }}>ลืม PIN?</h2>
          <p style={{ color: "#b0728a", fontSize: 12, margin: "0 0 20px" }}>ระบบจะค้นหา PIN ของคุณอัตโนมัติ<br />แล้วถอดรหัสข้อมูลเดิมกลับมาให้<br />ข้อมูลจะไม่หายไปไหน</p>
          <button onClick={startRecovery} style={bst(true)}>🔍 ค้นหา PIN และกู้ข้อมูล</button>
          <button onClick={() => setShowRecovery(false)} style={bst(false)}>← กลับ</button>
        </>)}
      </div>
      <style>{`@keyframes floatUp{0%{transform:translateY(0) rotate(0);opacity:0}10%{opacity:1}90%{opacity:1}100%{transform:translateY(-110vh) rotate(25deg);opacity:0}}`}</style>
    </div>
  );

  // ── Normal PIN Screen ──
  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,#fff0f3,#ffe0ec,#fce4ec)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: F, padding: 20 }}>
      <link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;600;700;800&display=swap" rel="stylesheet" /><Hearts />
      <div style={{ textAlign: "center", zIndex: 1 }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>💑</div>
        <h2 style={{ color: pkd, fontWeight: 800, fontSize: 20, margin: "0 0 6px" }}>{title}</h2>
        <p style={{ color: "#b0728a", fontSize: 13, margin: "0 0 24px" }}>{sub}</p>
        <div style={{ display: "flex", gap: 16, justifyContent: "center", marginBottom: 10, animation: shake ? "shakeX .4s ease" : "none" }}>
          {Array.from({ length: PINLEN }, (_, i) => <div key={i} style={{ width: 18, height: 18, borderRadius: "50%", border: `2px solid ${pk}`, background: i < cur.length ? pk : "transparent", transition: "all .15s" }} />)}
        </div>
        {err && <p style={{ color: "#e53935", fontSize: 13, fontWeight: 600, margin: "8px 0" }}>{err}</p>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,72px)", gap: 12, justifyContent: "center", marginTop: 20 }}>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, null, 0, "⌫"].map((n, i) => <button key={i} onClick={() => n === "⌫" ? del() : n !== null && go(String(n))} disabled={lock > 0 && n !== "⌫" && n !== null} style={{ width: 72, height: 72, borderRadius: "50%", border: n === null ? "none" : `2px solid ${lock > 0 ? "#ddd" : pk}`, background: n === null ? "transparent" : "rgba(255,255,255,.8)", color: lock > 0 ? "#ccc" : pkd, fontSize: n === "⌫" ? 22 : 26, fontWeight: 700, cursor: n === null ? "default" : "pointer", fontFamily: F, visibility: n === null ? "hidden" : "visible" }}>{n}</button>)}
        </div>
        {mode === "enter" && <button onClick={() => setShowRecovery(true)} style={{ background: "none", border: "none", color: "#d4869e", fontSize: 13, cursor: "pointer", fontFamily: F, marginTop: 20, textDecoration: "underline" }}>ลืม PIN? กดที่นี่</button>}
        <div style={{ marginTop: 20, padding: "10px 20px", background: "rgba(255,255,255,.7)", borderRadius: 12, fontSize: 11, color: "#b0728a", lineHeight: 1.5 }}>🛡️ AES-256-GCM • PBKDF2 310K • HMAC-SHA256<br />🔄 Real-time Shared Sync • OWASP 2025</div>
      </div>
      <style>{`@keyframes shakeX{0%,100%{transform:translateX(0)}20%{transform:translateX(-10px)}40%{transform:translateX(10px)}60%{transform:translateX(-6px)}80%{transform:translateX(6px)}}@keyframes floatUp{0%{transform:translateY(0) rotate(0);opacity:0}10%{opacity:1}90%{opacity:1}100%{transform:translateY(-110vh) rotate(25deg);opacity:0}}`}</style>
    </div>
  );
}

// ═══ MAIN APP ═══
export default function App() {
  const [isAuth, setAuth] = useState(false);
  const [hasPin, setHasPin] = useState(false);
  const [cKey, setCKey] = useState(null);
  const [pHash, setPHash] = useState(null);
  const [pinErr, setPinErr] = useState("");
  const [lockSec, setLockSec] = useState(0);
  const pinRL = useRef(new RL(MAX_PIN, LOCK_MS));
  const actRef = useRef(Date.now());
  const txRL = useRef(new RL(10, 60000));
  const saving = useRef(false);
  const verRef = useRef("0");
  const dataRef = useRef(null);

  const [data, _setData] = useState(INIT_DATA);
  const setData = useCallback(fn => { _setData(prev => { const next = typeof fn === "function" ? fn(prev) : fn; dataRef.current = next; return next; }); }, []);
  useEffect(() => { dataRef.current = data; }, [data]);

  const [tab, setTab] = useState("home");
  const [showAdd, setShowAdd] = useState(false);
  const [showSettle, setShowSettle] = useState(false);
  const [settleType, setSettleType] = useState("cash"); // cash | credit | all
  const [editNames, setEditNames] = useState(false);
  const [tempNames, setTempNames] = useState(["ฉัน", "แฟน"]);
  const [toast, setToast] = useState(null);
  const [receiptPrev, setReceiptPrev] = useState(null);
  const [showSec, setShowSec] = useState(false);
  const [confirmDel, setConfirmDel] = useState(null);
  const [syncSt, setSyncSt] = useState("idle");
  const [lastSync, setLastSync] = useState(null);
  const [showDueSetting, setShowDueSetting] = useState(false);
  const [tempDue, setTempDue] = useState(25);
  const [addMode, setAddMode] = useState("normal"); // normal | split
  const fileRef = useRef();

  // Change PIN
  const [showCP, setShowCP] = useState(false);
  const [cpStep, setCpStep] = useState("old");
  const [cpOld, setCpOld] = useState("");
  const [cpNew, setCpNew] = useState("");
  const [cpConf, setCpConf] = useState("");
  const [cpErr, setCpErr] = useState("");
  const [cpShake, setCpShake] = useState(false);

  // Form
  const [fP, setFP] = useState(0);
  const [fA, setFA] = useState("");
  const [fN, setFN] = useState("");
  const [fC, setFC] = useState("food");
  const [fR, setFR] = useState(null);
  const [fPay, setFPay] = useState("cash"); // cash | credit
  const [fMode, setFMode] = useState("none"); // none | half | itemized

  // Itemized split fields (only used when fMode === "itemized")
  const [fItems0, setFItems0] = useState([{ name: "", price: "" }]);
  const [fItems1, setFItems1] = useState([{ name: "", price: "" }]);
  const [fDelivery, setFDelivery] = useState("");
  const [fCoupon, setFCoupon] = useState("");
  const [fCouponType, setFCouponType] = useState("all"); // all | 0 | 1

  // ── Init ──
  useEffect(() => { (async () => { try { setHasPin(!!(await sGet("pin_hash"))); Log.log("INIT", "Loaded"); } catch { setHasPin(false); } })(); }, []);
  useEffect(() => { if (!isAuth) return; const id = setInterval(() => { if (Date.now() - actRef.current > TIMEOUT) { lockS(); } }, 10000); return () => clearInterval(id); }, [isAuth]);
  const resetAct = useCallback(() => { actRef.current = Date.now(); }, []);
  useEffect(() => { if (!isAuth) return; const ev = ["click", "keydown", "touchstart", "scroll"]; ev.forEach(e => window.addEventListener(e, resetAct, { passive: true })); return () => ev.forEach(e => window.removeEventListener(e, resetAct)); }, [isAuth, resetAct]);
  useEffect(() => { if (lockSec <= 0) return; const id = setInterval(() => setLockSec(pinRL.current.left()), 1000); return () => clearInterval(id); }, [lockSec]);

  const handleSetup = async pin => { try { const salt = Crypto.salt(); const ph = await Crypto.hash(pin, salt); const key = await Crypto.deriveKey(pin, salt); const enc = await Crypto.encrypt(INIT_DATA, key); const hm = await Crypto.hmac(INIT_DATA, ph); await sSet("pin_hash", ph); await sSet("pin_salt", salt); await sSet("app_data", JSON.stringify(enc)); await sSet("data_hmac", hm); await sSet("data_ver", "1"); setCKey(key); setPHash(ph); setData(INIT_DATA); setAuth(true); setHasPin(true); verRef.current = "1"; } catch { Log.log("SETUP_FAIL", "", "critical"); } };

  const handleVerify = async pin => {
    if (!pinRL.current.ok()) { setLockSec(pinRL.current.left()); return; }
    try {
      pinRL.current.rec(); const salt = await sGet("pin_salt"); const stored = await sGet("pin_hash"); if (!salt || !stored) { setPinErr("ยังไม่มี PIN"); return; }
      const ph = await Crypto.hash(pin, salt);
      if (ph !== stored) { const rem = MAX_PIN - pinRL.current.a.length; setPinErr(`PIN ไม่ถูกต้อง (เหลือ ${Math.max(0, rem)} ครั้ง)`); if (!pinRL.current.ok()) setLockSec(pinRL.current.left()); return; }
      const key = await Crypto.deriveKey(pin, salt); const encStr = await sGet("app_data");
      if (!encStr) { setCKey(key); setPHash(ph); setAuth(true); return; }
      const dec = await Crypto.decrypt(JSON.parse(encStr), key); if (!dec) { setPinErr("ถอดรหัสไม่ได้"); return; }
      const sHm = await sGet("data_hmac"); if (sHm) { const comp = await Crypto.hmac(dec, ph); if (comp !== sHm) { setPinErr("⚠️ ข้อมูลถูกดัดแปลง!"); return; } }
      // Migrate old data without creditDueDay
      const migrated = { ...INIT_DATA, ...dec, creditDueDay: dec.creditDueDay || 25 };
      const ver = await sGet("data_ver"); verRef.current = ver || "0";
      setCKey(key); setPHash(ph); setData(migrated); setTempNames(migrated.names); setTempDue(migrated.creditDueDay); setAuth(true); setPinErr("");
    } catch { setPinErr("เกิดข้อผิดพลาด"); }
  };

  const save = useCallback(async d => {
    if (!cKey || !pHash || saving.current) return; saving.current = true;
    try { const enc = await Crypto.encrypt(d, cKey); const hm = await Crypto.hmac(d, pHash); const nv = String(parseInt(verRef.current || "0", 10) + 1); await sSet("app_data", JSON.stringify(enc)); await sSet("data_hmac", hm); await sSet("data_ver", nv); verRef.current = nv; setSyncSt("synced"); setLastSync(new Date()); } catch { setSyncSt("error"); }
    saving.current = false;
  }, [cKey, pHash]);

  useEffect(() => { if (isAuth && cKey) save(data); }, [data, isAuth, cKey, save]);

  // Auto-sync
  useEffect(() => {
    if (!isAuth || !cKey || !pHash) return;
    const poll = async () => { if (saving.current) return; try { const rv = await sGet("data_ver"); if (rv && rv !== verRef.current) { setSyncSt("syncing"); const encStr = await sGet("app_data"); if (!encStr) return; const dec = await Crypto.decrypt(JSON.parse(encStr), cKey); if (!dec) { setSyncSt("error"); return; } const sHm = await sGet("data_hmac"); if (sHm) { const comp = await Crypto.hmac(dec, pHash); if (comp !== sHm) { setSyncSt("error"); return; } } const migrated = { ...INIT_DATA, ...dec, creditDueDay: dec.creditDueDay || 25 }; if (JSON.stringify(dataRef.current) !== JSON.stringify(migrated)) { setData(migrated); setTempNames(migrated.names); setTempDue(migrated.creditDueDay); } verRef.current = rv; } setSyncSt("synced"); setLastSync(new Date()); } catch { setSyncSt("error"); } };
    poll(); const id = setInterval(poll, SYNC_MS); return () => clearInterval(id);
  }, [isAuth, cKey, pHash, setData]);

  const lockS = () => { setAuth(false); setCKey(null); setPHash(null); setPinErr(""); };
  const toast2 = m => { setToast(S.txt(m, 80)); setTimeout(() => setToast(null), 2500); };
  const forceSync = async () => { setSyncSt("syncing"); try { const encStr = await sGet("app_data"); if (!encStr) return; const dec = await Crypto.decrypt(JSON.parse(encStr), cKey); if (dec) { const m = { ...INIT_DATA, ...dec, creditDueDay: dec.creditDueDay || 25 }; setData(m); setTempNames(m.names); setTempDue(m.creditDueDay); } const rv = await sGet("data_ver"); if (rv) verRef.current = rv; setSyncSt("synced"); setLastSync(new Date()); toast2("ซิงค์แล้ว! 🔄"); } catch { setSyncSt("error"); } };

  // ── Computed ──
  const names = data.names, txs = data.transactions, dueDay = data.creditDueDay || 25;

  const balanceCash = useMemo(() => { let b = 0; txs.filter(t => !t.settled && (t.payMethod || "cash") === "cash").forEach(t => { const a = t.split ? t.amount / 2 : t.amount; t.payer === 0 ? b += a : b -= a; }); return b; }, [txs]);
  const balanceCredit = useMemo(() => { let b = 0; txs.filter(t => !t.settled && t.payMethod === "credit").forEach(t => { const a = t.split ? t.amount / 2 : t.amount; t.payer === 0 ? b += a : b -= a; }); return b; }, [txs]);
  const balanceAll = balanceCash + balanceCredit;

  const pendingCash = txs.filter(t => !t.settled && (t.payMethod || "cash") === "cash").length;
  const pendingCredit = txs.filter(t => !t.settled && t.payMethod === "credit").length;
  const pendingAll = pendingCash + pendingCredit;

  // Credit card due date warning
  const dueWarning = useMemo(() => {
    if (pendingCredit === 0) return null;
    const now = new Date();
    const day = now.getDate(), month = now.getMonth(), year = now.getFullYear();
    let dueDate = new Date(year, month, dueDay);
    if (day > dueDay) dueDate = new Date(year, month + 1, dueDay); // next month
    const diff = Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24));
    if (diff <= 7) return { days: diff, date: dueDate };
    return null;
  }, [dueDay, pendingCredit]);

  const mStats = useMemo(() => {
    const n = new Date(); const m = txs.filter(t => { const d = new Date(t.date); return d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear(); });
    const cashTotal = m.filter(t => (t.payMethod || "cash") === "cash").reduce((s, t) => s + t.amount, 0);
    const creditTotal = m.filter(t => t.payMethod === "credit").reduce((s, t) => s + t.amount, 0);
    const bc = {}; m.forEach(t => { bc[t.category] = (bc[t.category] || 0) + t.amount; });
    return { cashTotal, creditTotal, total: cashTotal + creditTotal, cnt: m.length, cats: Object.entries(bc).sort((a, b) => b[1] - a[1]) };
  }, [txs]);

  // ── Split calc (for itemized mode) ──
  const splitCalc = useMemo(() => {
    if (fMode !== "itemized") return null;
    const sum = items => items.reduce((s, it) => s + (S.num(it.price, 0) || 0), 0);
    const t0 = sum(fItems0), t1 = sum(fItems1);
    const delivery = S.num(fDelivery, 0) || 0;
    const coupon = S.num(fCoupon, 0) || 0;
    const delEach = delivery / 2;
    let disc0 = 0, disc1 = 0;
    if (fCouponType === "all") { disc0 = coupon / 2; disc1 = coupon / 2; }
    else if (fCouponType === "0") { disc0 = coupon; } else { disc1 = coupon; }
    const pay0 = Math.max(0, Math.round((t0 + delEach - disc0) * 100) / 100);
    const pay1 = Math.max(0, Math.round((t1 + delEach - disc1) * 100) / 100);
    const total = pay0 + pay1;
    const oweAmount = fP === 0 ? pay1 : pay0;
    const otherPerson = fP === 0 ? 1 : 0;
    return { t0, t1, delivery, coupon, delEach, disc0, disc1, pay0, pay1, total, oweAmount, otherPerson };
  }, [fMode, fItems0, fItems1, fDelivery, fCoupon, fCouponType, fP]);

  // ── Unified add transaction ──
  const addTx = () => {
    if (!txRL.current.ok()) { toast2("⚠️ เพิ่มบ่อยเกินไป"); return; }
    if (txs.length >= MAX_TX) { toast2("⚠️ เกินจำนวนสูงสุด"); return; }

    if (fMode === "itemized") {
      // Itemized split
      if (!splitCalc || splitCalc.total <= 0) { toast2("ยังไม่มีรายการอาหาร"); return; }
      txRL.current.rec();
      const items0 = fItems0.filter(it => it.name && S.num(it.price, 0)).map(it => ({ name: S.txt(it.name, 50), price: S.num(it.price, 0) }));
      const items1 = fItems1.filter(it => it.name && S.num(it.price, 0)).map(it => ({ name: S.txt(it.name, 50), price: S.num(it.price, 0) }));
      const noteItems = [...items0.map(i => i.name), ...items1.map(i => i.name)].join(", ");
      const tx = {
        id: data.nextId, payer: S.payer(fP), amount: splitCalc.oweAmount,
        note: S.txt(fN || noteItems || "หารแยกเมนู", 100), category: S.cat(fC), split: false, receipt: S.img(fR),
        payMethod: S.pay(fPay), date: new Date().toISOString(), settled: false,
        splitDetail: { items0, items1, delivery: splitCalc.delivery, coupon: splitCalc.coupon, couponType: fCouponType, pay0: splitCalc.pay0, pay1: splitCalc.pay1, paidBy: fP }
      };
      setData(d => ({ ...d, transactions: [tx, ...d.transactions], nextId: d.nextId + 1 }));
    } else {
      // Normal or half
      const amt = S.num(fA, 0.01); if (!amt) { toast2("จำนวนเงินไม่ถูกต้อง 💸"); return; }
      txRL.current.rec();
      const tx = { id: data.nextId, payer: S.payer(fP), amount: amt, note: S.txt(fN, 100) || "ไม่ระบุ", category: S.cat(fC), split: fMode === "half", receipt: S.img(fR), payMethod: S.pay(fPay), date: new Date().toISOString(), settled: false };
      setData(d => ({ ...d, transactions: [tx, ...d.transactions], nextId: d.nextId + 1 }));
    }
    // Reset form
    setFA(""); setFN(""); setFC("food"); setFR(null); setFP(0); setFPay("cash"); setFMode("none");
    setFItems0([{ name: "", price: "" }]); setFItems1([{ name: "", price: "" }]);
    setFDelivery(""); setFCoupon(""); setFCouponType("all");
    setShowAdd(false); toast2("บันทึกแล้ว! 💖");
  };
  const doSettle = (type) => {
    setData(d => ({ ...d, transactions: d.transactions.map(t => {
      if (t.settled) return t;
      if (type === "all") return { ...t, settled: true };
      if (type === "cash" && (t.payMethod || "cash") === "cash") return { ...t, settled: true };
      if (type === "credit" && t.payMethod === "credit") return { ...t, settled: true };
      return t;
    }) }));
    setShowSettle(false);
    toast2(type === "credit" ? "เคลียร์ยอดบัตรเครดิตแล้ว! 💳" : type === "cash" ? "เคลียร์ยอดเงินสดแล้ว! 💵" : "เคลียร์ทั้งหมดแล้ว! 🎉");
  };
  const delTx = id => { const n = parseInt(id, 10); if (isNaN(n)) return; setData(d => ({ ...d, transactions: d.transactions.filter(t => t.id !== n) })); setConfirmDel(null); toast2("ลบแล้ว 🗑️"); };
  const handleFile = e => { try { const f = e.target.files?.[0]; if (!f) return; if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(f.type)) { toast2("⚠️ รองรับเฉพาะรูปภาพ"); return; } if (f.size > MAX_IMG * 1024 * 1024) { toast2(`⚠️ เกิน ${MAX_IMG}MB`); return; } const r = new FileReader(); r.onerror = () => toast2("⚠️ อ่านไม่ได้"); r.onload = ev => { const v = S.img(ev.target.result); if (v) setFR(v); else toast2("⚠️ ไม่ถูกต้อง"); }; r.readAsDataURL(f); } catch { toast2("⚠️ ผิดพลาด"); } };
  const saveNm = () => { const a = S.txt(tempNames[0], 20), b = S.txt(tempNames[1], 20); if (a && b) { setData(d => ({ ...d, names: [a, b] })); setEditNames(false); toast2("เปลี่ยนชื่อแล้ว! 💕"); } };
  const saveDue = () => { const d = parseInt(tempDue, 10); if (d >= 1 && d <= 31) { setData(prev => ({ ...prev, creditDueDay: d })); setShowDueSetting(false); toast2(`ตั้งวันครบกำหนดเป็นวันที่ ${d} แล้ว! 💳`); } };

  // Change PIN
  const openCP = () => { setCpStep("old"); setCpOld(""); setCpNew(""); setCpConf(""); setCpErr(""); setShowCP(true); };
  const cpShk = () => { setCpShake(true); setTimeout(() => setCpShake(false), 500); };
  const cpDot = async n => {
    if (cpStep === "old") { const nx = cpOld + n; setCpOld(nx); if (nx.length === PINLEN) { try { const sl = await sGet("pin_salt"); const sh = await sGet("pin_hash"); const ph = await Crypto.hash(nx, sl); if (ph !== sh) { setCpErr("PIN เก่าไม่ถูกต้อง"); setCpOld(""); cpShk(); return; } setCpStep("new"); setCpErr(""); } catch { setCpErr("ผิดพลาด"); setCpOld(""); } } }
    else if (cpStep === "new") { const nx = cpNew + n; setCpNew(nx); if (nx.length === PINLEN) { setCpStep("confirm"); setCpErr(""); } }
    else { const nx = cpConf + n; setCpConf(nx); if (nx.length === PINLEN) { if (nx !== cpNew) { setCpErr("PIN ไม่ตรงกัน"); setCpConf(""); setCpStep("new"); setCpNew(""); cpShk(); return; } try { const ns = Crypto.salt(); const nh = await Crypto.hash(nx, ns); const nk = await Crypto.deriveKey(nx, ns); const enc = await Crypto.encrypt(data, nk); const hm = await Crypto.hmac(data, nh); const nv = String(parseInt(verRef.current || "0", 10) + 1); await sSet("pin_hash", nh); await sSet("pin_salt", ns); await sSet("app_data", JSON.stringify(enc)); await sSet("data_hmac", hm); await sSet("data_ver", nv); verRef.current = nv; setCKey(nk); setPHash(nh); setShowCP(false); toast2("เปลี่ยน PIN สำเร็จ! 🔐"); } catch { setCpErr("ผิดพลาด"); } } }
  };
  const cpDel = () => cpStep === "old" ? setCpOld(x => x.slice(0, -1)) : cpStep === "new" ? setCpNew(x => x.slice(0, -1)) : setCpConf(x => x.slice(0, -1));

  const ce = id => CATS.find(c => c.id === id)?.e || "💫";
  const cl = id => CATS.find(c => c.id === id)?.l || "อื่นๆ";
  const fmt = n => n.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  const F = `'Sarabun','Noto Sans Thai',sans-serif`;
  const pk = "#e8628c", pkl = "#fce4ec", pkd = "#c2185b", pks = "#f8bbd0";
  const cbg = "rgba(255,255,255,.82)", shd = "0 4px 24px rgba(232,98,140,.10)", rad = "20px";
  const bt = p => ({ padding: "12px 28px", borderRadius: 14, border: p ? "none" : `2px solid ${pks}`, background: p ? `linear-gradient(135deg,${pk},${pkd})` : "white", color: p ? "white" : pk, fontWeight: 700, fontSize: 15, cursor: "pointer", fontFamily: F, transition: "all .2s", boxShadow: p ? "0 4px 16px rgba(232,98,140,.25)" : "none" });
  const tbt = a => ({ flex: 1, padding: "10px 0", border: "none", background: a ? pk : "transparent", color: a ? "white" : "#b0728a", fontWeight: 700, fontSize: 12, cursor: "pointer", borderRadius: 12, fontFamily: F });
  const syncDot = syncSt === "synced" ? "#4caf50" : syncSt === "syncing" ? "#ff9800" : syncSt === "error" ? "#e53935" : "#ccc";

  // ── Recovery: login with brute-forced PIN ──
  const handleRecovered = async (pin, recoveredData) => {
    try {
      const salt = await sGet("pin_salt");
      const ph = await Crypto.hash(pin, salt);
      const key = await Crypto.deriveKey(pin, salt);
      const migrated = { ...INIT_DATA, ...recoveredData, creditDueDay: recoveredData.creditDueDay || 25 };
      const ver = await sGet("data_ver"); verRef.current = ver || "0";
      setCKey(key); setPHash(ph); setData(migrated); setTempNames(migrated.names); setTempDue(migrated.creditDueDay); setAuth(true); setPinErr("");
    } catch { setPinErr("เกิดข้อผิดพลาด"); }
  };

  // ── Full reset ──
  const handleFullReset = async () => {
    try {
      for (const k of ["pin_hash", "pin_salt", "app_data", "data_hmac", "data_ver"]) { await sSet(k, ""); }
      setHasPin(false); setAuth(false); setCKey(null); setPHash(null); setPinErr("");
    } catch {}
  };

  if (!isAuth) return <PinScreen mode={hasPin ? "enter" : "setup"} onOk={handleVerify} onSetup={handleSetup} lock={lockSec} onRecovered={handleRecovered} onReset={handleFullReset} />;

  // ═══ MAIN UI ═══
  return (
    <div onClick={resetAct} style={{ minHeight: "100vh", background: "linear-gradient(160deg,#fff0f3,#ffe0ec,#fce4ec)", fontFamily: F, position: "relative", overflow: "hidden" }}>
      <link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;600;700;800&display=swap" rel="stylesheet" /><Hearts />

      {toast && <div style={{ position: "fixed", top: 24, left: "50%", transform: "translateX(-50%)", background: "white", color: pk, padding: "12px 28px", borderRadius: 16, fontWeight: 700, fontSize: 15, boxShadow: "0 8px 32px rgba(232,98,140,.2)", zIndex: 999, fontFamily: F, animation: "popIn .3s ease" }}>{toast}</div>}
      {receiptPrev && <div onClick={() => setReceiptPrev(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", zIndex: 900, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}><img src={receiptPrev} style={{ maxWidth: "90%", maxHeight: "80vh", borderRadius: 16 }} /></div>}
      {confirmDel !== null && <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.3)", zIndex: 800, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}><div style={{ background: "white", borderRadius: rad, padding: 28, maxWidth: 320, textAlign: "center" }}><div style={{ fontSize: 36, marginBottom: 10 }}>🗑️</div><h3 style={{ margin: "0 0 8px", color: pkd, fontSize: 16 }}>ยืนยันการลบ?</h3><p style={{ color: "#b0728a", fontSize: 13, margin: "0 0 18px" }}>ลบแล้วกู้คืนไม่ได้</p><div style={{ display: "flex", gap: 10 }}><button onClick={() => setConfirmDel(null)} style={bt(false)}>ยกเลิก</button><button onClick={() => delTx(confirmDel)} style={{ ...bt(true), flex: 1 }}>ลบเลย</button></div></div></div>}

      {/* Change PIN Modal */}
      {showCP && (() => { const cur = cpStep === "old" ? cpOld : cpStep === "new" ? cpNew : cpConf; const tl = cpStep === "old" ? "🔑 ใส่ PIN เก่า" : cpStep === "new" ? "🔐 PIN ใหม่" : "🔐 ยืนยัน PIN ใหม่"; return <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", zIndex: 850, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}><div style={{ background: "white", borderRadius: rad, padding: "28px 24px", width: "100%", maxWidth: 340, textAlign: "center" }}><h3 style={{ margin: "0 0 4px", color: pkd, fontSize: 17, fontWeight: 800 }}>{tl}</h3><div style={{ display: "flex", justifyContent: "center", gap: 8, margin: "16px 0" }}>{["old", "new", "confirm"].map((s, i) => <div key={s} style={{ display: "flex", alignItems: "center", gap: 4 }}><div style={{ width: 24, height: 24, borderRadius: "50%", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", background: cpStep === s ? pk : ["old", "new", "confirm"].indexOf(cpStep) > i ? "#e8f5e9" : "#f5f5f5", color: cpStep === s ? "white" : ["old", "new", "confirm"].indexOf(cpStep) > i ? "#43a047" : "#ccc" }}>{["old", "new", "confirm"].indexOf(cpStep) > i ? "✓" : i + 1}</div>{i < 2 && <div style={{ width: 16, height: 2, background: "#eee" }} />}</div>)}</div><div style={{ display: "flex", gap: 14, justifyContent: "center", marginBottom: 8, animation: cpShake ? "shakeX .4s ease" : "none" }}>{Array.from({ length: PINLEN }, (_, i) => <div key={i} style={{ width: 16, height: 16, borderRadius: "50%", border: `2px solid ${pk}`, background: i < cur.length ? pk : "transparent" }} />)}</div>{cpErr && <p style={{ color: "#e53935", fontSize: 12, fontWeight: 600, margin: "6px 0" }}>{cpErr}</p>}<div style={{ display: "grid", gridTemplateColumns: "repeat(3,56px)", gap: 8, justifyContent: "center", marginTop: 14 }}>{[1, 2, 3, 4, 5, 6, 7, 8, 9, null, 0, "⌫"].map((n, i) => <button key={i} onClick={() => n === "⌫" ? cpDel() : n !== null && cpDot(String(n))} style={{ width: 56, height: 56, borderRadius: "50%", border: n === null ? "none" : `2px solid ${pk}`, background: n === null ? "transparent" : "rgba(255,255,255,.9)", color: pkd, fontSize: n === "⌫" ? 18 : 20, fontWeight: 700, cursor: n === null ? "default" : "pointer", fontFamily: F, visibility: n === null ? "hidden" : "visible" }}>{n}</button>)}</div><button onClick={() => setShowCP(false)} style={{ ...bt(false), marginTop: 16, width: "100%", fontSize: 13 }}>ยกเลิก</button></div></div>; })()}

      {/* Due Day Setting Modal */}
      {showDueSetting && <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.3)", zIndex: 800, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}><div style={{ background: "white", borderRadius: rad, padding: 28, maxWidth: 340, textAlign: "center" }}>
        <div style={{ fontSize: 36, marginBottom: 10 }}>💳</div><h3 style={{ margin: "0 0 8px", color: pkd, fontSize: 16 }}>ตั้งวันครบกำหนดจ่ายบัตร</h3>
        <p style={{ color: "#b0728a", fontSize: 13, margin: "0 0 16px" }}>ทุกเดือน วันที่เท่าไหร่?</p>
        <input type="number" value={tempDue} onChange={e => setTempDue(e.target.value)} min={1} max={31} style={{ width: 100, padding: "14px", borderRadius: 14, border: `2px solid ${pks}`, fontSize: 28, fontWeight: 800, fontFamily: F, color: pkd, textAlign: "center", outline: "none" }} />
        <div style={{ display: "flex", gap: 10, marginTop: 18 }}><button onClick={() => setShowDueSetting(false)} style={bt(false)}>ยกเลิก</button><button onClick={saveDue} style={{ ...bt(true), flex: 1 }}>บันทึก 💳</button></div>
      </div></div>}

      {/* Settle Modal */}
      {showSettle && <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.3)", zIndex: 800, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}><div style={{ background: "white", borderRadius: rad, padding: 28, width: "100%", maxWidth: 360, textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>💸</div><h3 style={{ margin: "0 0 16px", color: pkd }}>เคลียร์ยอดค้าง</h3>
        {/* Cash option */}
        {pendingCash > 0 && <button onClick={() => doSettle("cash")} style={{ width: "100%", padding: "14px 16px", borderRadius: 14, border: `2px solid ${pks}`, background: "white", cursor: "pointer", fontFamily: F, marginBottom: 10, textAlign: "left", display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 24 }}>💵</span>
          <div style={{ flex: 1 }}><div style={{ fontWeight: 700, fontSize: 14, color: "#4a2036" }}>เคลียร์เงินสด</div><div style={{ fontSize: 12, color: "#b0728a" }}>{pendingCash} รายการ • ฿{fmt(Math.abs(balanceCash))}</div></div>
          <span style={{ color: pk, fontWeight: 700, fontSize: 20 }}>›</span>
        </button>}
        {/* Credit option */}
        {pendingCredit > 0 && <button onClick={() => doSettle("credit")} style={{ width: "100%", padding: "14px 16px", borderRadius: 14, border: "2px solid #bbdefb", background: "#e3f2fd", cursor: "pointer", fontFamily: F, marginBottom: 10, textAlign: "left", display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 24 }}>💳</span>
          <div style={{ flex: 1 }}><div style={{ fontWeight: 700, fontSize: 14, color: "#1565c0" }}>เคลียร์บัตรเครดิต</div><div style={{ fontSize: 12, color: "#5c8fbd" }}>{pendingCredit} รายการ • ฿{fmt(Math.abs(balanceCredit))}</div></div>
          <span style={{ color: "#1565c0", fontWeight: 700, fontSize: 20 }}>›</span>
        </button>}
        {/* All option */}
        {pendingAll > 0 && <button onClick={() => doSettle("all")} style={{ ...bt(true), width: "100%", marginBottom: 10 }}>เคลียร์ทั้งหมด ({pendingAll} รายการ)</button>}
        <button onClick={() => setShowSettle(false)} style={{ ...bt(false), width: "100%" }}>ยกเลิก</button>
      </div></div>}


      <div style={{ maxWidth: 420, margin: "0 auto", padding: "0 16px 100px", position: "relative", zIndex: 1 }}>
        {/* Header */}
        <div style={{ textAlign: "center", paddingTop: 24, paddingBottom: 4 }}>
          <div style={{ fontSize: 36, marginBottom: 4 }}>💑</div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: pkd, margin: 0 }}>{names[0]} 💕 {names[1]}</h1>
          <button onClick={forceSync} style={{ background: "none", border: "none", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, margin: "6px 0 0", padding: "4px 12px", borderRadius: 20, fontFamily: F, fontSize: 11, color: "#b0728a" }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: syncDot, animation: syncSt === "syncing" ? "pulse 1s infinite" : "none" }} /> 🔄 {syncSt === "synced" ? "ซิงค์แล้ว" : syncSt === "syncing" ? "กำลังซิงค์..." : "ซิงค์ผิดพลาด"}
          </button>
          <div style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 6, flexWrap: "wrap" }}>
            <button onClick={() => { setTempNames([...names]); setEditNames(true); }} style={{ background: "none", border: "none", color: "#d4869e", fontSize: 11, cursor: "pointer", fontFamily: F }}>✏️ แก้ชื่อ</button>
            <button onClick={openCP} style={{ background: "none", border: "none", color: "#d4869e", fontSize: 11, cursor: "pointer", fontFamily: F }}>🔑 PIN</button>
            <button onClick={() => { setTempDue(dueDay); setShowDueSetting(true); }} style={{ background: "none", border: "none", color: "#d4869e", fontSize: 11, cursor: "pointer", fontFamily: F }}>💳 วันจ่ายบัตร ({dueDay})</button>
            <button onClick={lockS} style={{ background: "none", border: "none", color: "#d4869e", fontSize: 11, cursor: "pointer", fontFamily: F }}>🔒 ล็อก</button>
          </div>
        </div>

        {/* Edit Names */}
        {editNames && <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.3)", zIndex: 800, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}><div style={{ background: "white", borderRadius: rad, padding: 28, width: "100%", maxWidth: 340 }}><h3 style={{ margin: "0 0 20px", color: pkd, textAlign: "center" }}>💕 ตั้งชื่อคู่ของเรา</h3>{[0, 1].map(i => <input key={i} value={tempNames[i]} onChange={e => { const n = [...tempNames]; n[i] = e.target.value; setTempNames(n); }} maxLength={20} placeholder={i === 0 ? "ชื่อฉัน" : "ชื่อแฟน"} style={{ width: "100%", padding: "12px 16px", borderRadius: 12, border: `2px solid ${pks}`, fontSize: 15, fontFamily: F, marginBottom: 12, boxSizing: "border-box", outline: "none" }} />)}<div style={{ display: "flex", gap: 10, marginTop: 8 }}><button onClick={() => setEditNames(false)} style={bt(false)}>ยกเลิก</button><button onClick={saveNm} style={{ ...bt(true), flex: 1 }}>บันทึก 💖</button></div></div></div>}

        {/* Credit Due Warning */}
        {dueWarning && <div style={{ background: "linear-gradient(135deg,#e3f2fd,#bbdefb)", borderRadius: 16, padding: "14px 18px", marginTop: 16, display: "flex", alignItems: "center", gap: 12, boxShadow: "0 4px 16px rgba(21,101,192,.12)" }}>
          <span style={{ fontSize: 28 }}>💳</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: "#1565c0" }}>
              {dueWarning.days <= 0 ? "⚠️ ถึงกำหนดจ่ายบัตรแล้ว!" : dueWarning.days === 1 ? "⚠️ พรุ่งนี้ครบกำหนดจ่ายบัตร!" : `⏰ อีก ${dueWarning.days} วัน ครบกำหนดจ่ายบัตร`}
            </div>
            <div style={{ fontSize: 12, color: "#5c8fbd" }}>วันที่ {dueDay} • ยอดค้างบัตร ฿{fmt(Math.abs(balanceCredit))} ({pendingCredit} รายการ)</div>
          </div>
        </div>}

        {/* Balance Cards */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 16 }}>
          {/* Cash Balance */}
          <div style={{ background: cbg, borderRadius: 16, padding: "18px 14px", boxShadow: shd, textAlign: "center", border: "1.5px solid rgba(232,98,140,.08)" }}>
            <div style={{ fontSize: 22, marginBottom: 4 }}>💵</div>
            <div style={{ fontSize: 11, color: "#b0728a", fontWeight: 600 }}>เงินสด</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: pkd, margin: "4px 0" }}>฿{fmt(Math.abs(balanceCash))}</div>
            {pendingCash > 0 && <div style={{ fontSize: 11, color: pk }}>{balanceCash > 0 ? `${names[1]} ติด` : balanceCash < 0 ? `${names[0]} ติด` : "เสมอ"}</div>}
            <div style={{ fontSize: 10, color: "#cca0b3" }}>{pendingCash} รายการ</div>
          </div>
          {/* Credit Balance */}
          <div style={{ background: "linear-gradient(135deg,#e8eaf6,#e3f2fd)", borderRadius: 16, padding: "18px 14px", boxShadow: shd, textAlign: "center", border: "1.5px solid rgba(21,101,192,.1)" }}>
            <div style={{ fontSize: 22, marginBottom: 4 }}>💳</div>
            <div style={{ fontSize: 11, color: "#5c6bc0", fontWeight: 600 }}>บัตรเครดิต</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: "#1565c0", margin: "4px 0" }}>฿{fmt(Math.abs(balanceCredit))}</div>
            {pendingCredit > 0 && <div style={{ fontSize: 11, color: "#5c6bc0" }}>{balanceCredit > 0 ? `${names[1]} ติด` : balanceCredit < 0 ? `${names[0]} ติด` : "เสมอ"}</div>}
            <div style={{ fontSize: 10, color: "#9fa8da" }}>{pendingCredit} รายการ • จ่ายวันที่ {dueDay}</div>
          </div>
        </div>

        {/* Total Balance */}
        <div style={{ background: cbg, borderRadius: 16, padding: "16px 20px", marginTop: 10, boxShadow: shd, display: "flex", alignItems: "center", justifyContent: "space-between", border: "1.5px solid rgba(232,98,140,.08)" }}>
          <div>
            <div style={{ fontSize: 12, color: "#b0728a", fontWeight: 600 }}>ยอดรวมทั้งหมด</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: pkd }}>฿{fmt(Math.abs(balanceAll))}</div>
            {pendingAll > 0 && <div style={{ fontSize: 12, color: pk }}>{balanceAll > 0 ? `${names[1]} ติด ${names[0]}` : balanceAll < 0 ? `${names[0]} ติด ${names[1]}` : "เสมอกัน! 🤝"}</div>}
          </div>
          {pendingAll > 0 && <button onClick={() => setShowSettle(true)} style={{ ...bt(true), padding: "10px 18px", fontSize: 13 }}>💸 เคลียร์</button>}
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 4, marginTop: 20, background: cbg, borderRadius: 16, padding: 4, boxShadow: shd }}>
          {[{ id: "home", l: "📋 รายการ" }, { id: "stats", l: "📊 สถิติ" }, { id: "history", l: "📜 ประวัติ" }].map(t => <button key={t.id} onClick={() => setTab(t.id)} style={tbt(tab === t.id)}>{t.l}</button>)}
        </div>

        <div style={{ marginTop: 16 }}>
          {/* HOME */}
          {tab === "home" && <div>
            {txs.filter(t => !t.settled).length === 0 ? <div style={{ background: cbg, borderRadius: rad, padding: "40px 20px", textAlign: "center", boxShadow: shd }}><div style={{ fontSize: 48, marginBottom: 12 }}>🌸</div><p style={{ color: "#b0728a", fontWeight: 600, fontSize: 15 }}>ยังไม่มีรายการ</p></div> :
            txs.filter(t => !t.settled).map(t => {
              const isCC = t.payMethod === "credit";
              return <div key={t.id} style={{ background: cbg, borderRadius: 16, padding: "14px 16px", marginBottom: 10, boxShadow: shd, display: "flex", alignItems: "center", gap: 12, border: isCC ? "1.5px solid rgba(21,101,192,.12)" : "1.5px solid rgba(232,98,140,.08)" }}>
                <div style={{ width: 42, height: 42, borderRadius: 14, background: isCC ? "#e3f2fd" : pkl, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>{ce(t.category)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: "#4a2036", marginBottom: 2, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    {t.note}
                    <span style={{ background: isCC ? "#e3f2fd" : "#fff8e1", color: isCC ? "#1565c0" : "#f57f17", fontSize: 9, padding: "1px 7px", borderRadius: 6, fontWeight: 700 }}>{isCC ? "💳 บัตร" : "💵 สด"}</span>
                    {t.split && <span style={{ background: pks, color: pkd, fontSize: 9, padding: "1px 7px", borderRadius: 6, fontWeight: 700 }}>หารสอง</span>}
                  </div>
                  <div style={{ fontSize: 11, color: "#b0728a" }}>{names[t.payer]} จ่ายให้ • {cl(t.category)}</div>
                  <div style={{ fontSize: 10, color: "#cca0b3", marginTop: 1 }}>{new Date(t.date).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" })}</div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontWeight: 800, fontSize: 15, color: isCC ? "#1565c0" : pkd }}>฿{fmt(t.split ? t.amount / 2 : t.amount)}</div>
                  {t.split && <div style={{ fontSize: 9, color: "#cca0b3" }}>จาก ฿{fmt(t.amount)}</div>}
                  <div style={{ display: "flex", gap: 5, marginTop: 5, justifyContent: "flex-end" }}>
                    {t.receipt && <button onClick={() => setReceiptPrev(t.receipt)} style={{ background: pkl, border: "none", borderRadius: 7, padding: "3px 7px", fontSize: 10, cursor: "pointer", color: pk }}>🧾</button>}
                    <button onClick={() => setConfirmDel(t.id)} style={{ background: "#fff0f0", border: "none", borderRadius: 7, padding: "3px 7px", fontSize: 10, cursor: "pointer", color: "#e57373" }}>✕</button>
                  </div>
                </div>
              </div>;
            })}
          </div>}

          {/* STATS */}
          {tab === "stats" && <div>
            <div style={{ background: cbg, borderRadius: rad, padding: "20px", boxShadow: shd, marginBottom: 12 }}>
              <p style={{ color: "#b0728a", fontSize: 13, fontWeight: 700, margin: "0 0 14px", textAlign: "center" }}>📊 สรุปเดือนนี้</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, textAlign: "center" }}>
                <div><div style={{ fontSize: 11, color: "#b0728a" }}>ทั้งหมด</div><div style={{ fontSize: 20, fontWeight: 800, color: pkd }}>฿{fmt(mStats.total)}</div></div>
                <div><div style={{ fontSize: 11, color: "#f57f17" }}>💵 สด</div><div style={{ fontSize: 18, fontWeight: 800, color: "#ef6c00" }}>฿{fmt(mStats.cashTotal)}</div></div>
                <div><div style={{ fontSize: 11, color: "#5c6bc0" }}>💳 บัตร</div><div style={{ fontSize: 18, fontWeight: 800, color: "#1565c0" }}>฿{fmt(mStats.creditTotal)}</div></div>
              </div>
              <div style={{ textAlign: "center", marginTop: 6 }}><span style={{ fontSize: 11, color: "#cca0b3" }}>{mStats.cnt} รายการ</span></div>
            </div>
            {mStats.cats.length > 0 && <div style={{ background: cbg, borderRadius: rad, padding: 20, boxShadow: shd, marginBottom: 12 }}><p style={{ color: "#b0728a", fontSize: 13, fontWeight: 700, margin: "0 0 14px" }}>หมวดหมู่</p>{mStats.cats.map(([c, a]) => { const p = mStats.total > 0 ? (a / mStats.total) * 100 : 0; return <div key={c} style={{ marginBottom: 12 }}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}><span style={{ fontSize: 13, fontWeight: 600, color: "#4a2036" }}>{ce(c)} {cl(c)}</span><span style={{ fontSize: 13, fontWeight: 700, color: pkd }}>฿{fmt(a)}</span></div><div style={{ height: 7, background: pkl, borderRadius: 4, overflow: "hidden" }}><div style={{ height: "100%", width: `${p}%`, background: `linear-gradient(90deg,${pk},${pkd})`, borderRadius: 4, transition: "width .6s" }} /></div></div>; })}</div>}
            {txs.length > 0 && <div style={{ background: cbg, borderRadius: rad, padding: 20, boxShadow: shd }}><p style={{ color: "#b0728a", fontSize: 13, fontWeight: 700, margin: "0 0 14px" }}>ใครจ่ายเท่าไหร่</p>{[0, 1].map(i => { const now = new Date(); const tot = txs.filter(t => { const d = new Date(t.date); return t.payer === i && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); }).reduce((s, t) => s + t.amount, 0); return <div key={i} style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}><span style={{ color: "#4a2036", fontWeight: 600, fontSize: 14 }}>{i === 0 ? "💁‍♀️" : "💁‍♂️"} {names[i]}</span><span style={{ color: pkd, fontWeight: 700, fontSize: 14 }}>฿{fmt(tot)}</span></div>; })}</div>}
          </div>}

          {/* HISTORY */}
          {tab === "history" && <div>
            {txs.filter(t => t.settled).length === 0 ? <div style={{ background: cbg, borderRadius: rad, padding: "40px 20px", textAlign: "center", boxShadow: shd }}><div style={{ fontSize: 40, marginBottom: 8 }}>📜</div><p style={{ color: "#b0728a", fontWeight: 600 }}>ยังไม่มีประวัติ</p></div> :
            txs.filter(t => t.settled).map(t => <div key={t.id} style={{ background: cbg, borderRadius: 14, padding: "12px 14px", marginBottom: 8, boxShadow: "0 2px 12px rgba(232,98,140,.06)", display: "flex", alignItems: "center", gap: 10, opacity: .7 }}>
              <div style={{ fontSize: 18 }}>{ce(t.category)}</div>
              <div style={{ flex: 1 }}><div style={{ fontWeight: 600, fontSize: 12, color: "#4a2036" }}>{t.note} <span style={{ background: t.payMethod === "credit" ? "#e3f2fd" : "#fff8e1", color: t.payMethod === "credit" ? "#1565c0" : "#f57f17", fontSize: 9, padding: "1px 6px", borderRadius: 5 }}>{t.payMethod === "credit" ? "💳" : "💵"}</span> <span style={{ background: "#e8f5e9", color: "#43a047", fontSize: 9, padding: "1px 6px", borderRadius: 5 }}>✓</span></div><div style={{ fontSize: 10, color: "#b0728a" }}>{names[t.payer]} • {new Date(t.date).toLocaleDateString("th-TH", { day: "numeric", month: "short" })}</div></div>
              <div style={{ fontWeight: 700, fontSize: 13, color: "#999" }}>฿{fmt(t.split ? t.amount / 2 : t.amount)}</div>
            </div>)}
          </div>}
        </div>
      </div>

      {/* FAB */}
      <button onClick={() => { setFMode("none"); setShowAdd(true); }} style={{ position: "fixed", bottom: 28, right: "calc(50% - 32px)", width: 64, height: 64, borderRadius: "50%", background: `linear-gradient(135deg,${pk},${pkd})`, color: "white", fontSize: 32, border: "none", cursor: "pointer", boxShadow: "0 6px 24px rgba(232,98,140,.35)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>

      {/* Unified Add Modal */}
      {showAdd && <div onClick={e => e.target === e.currentTarget && setShowAdd(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", zIndex: 800, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
        <div style={{ background: "white", borderRadius: "24px 24px 0 0", padding: "28px 24px 36px", width: "100%", maxWidth: 420, maxHeight: "85vh", overflowY: "auto", animation: "slideUp .3s ease" }}>
          <div style={{ textAlign: "center", marginBottom: 20 }}><div style={{ width: 40, height: 4, background: "#eee", borderRadius: 2, margin: "0 auto 16px" }} /><h3 style={{ margin: 0, color: pkd, fontSize: 18, fontWeight: 800 }}>💸 เพิ่มรายการใหม่</h3></div>

          {/* Payment Method */}
          <label style={{ fontSize: 13, fontWeight: 700, color: "#b0728a", display: "block", marginBottom: 8 }}>จ่ายด้วย</label>
          <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
            <button onClick={() => setFPay("cash")} style={{ flex: 1, padding: "12px", borderRadius: 14, border: fPay === "cash" ? "2px solid #ef6c00" : "2px solid #eee", background: fPay === "cash" ? "#fff8e1" : "white", color: fPay === "cash" ? "#ef6c00" : "#999", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: F }}>💵 เงินสด</button>
            <button onClick={() => setFPay("credit")} style={{ flex: 1, padding: "12px", borderRadius: 14, border: fPay === "credit" ? "2px solid #1565c0" : "2px solid #eee", background: fPay === "credit" ? "#e3f2fd" : "white", color: fPay === "credit" ? "#1565c0" : "#999", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: F }}>💳 บัตรเครดิต</button>
          </div>
          {fPay === "credit" && <div style={{ padding: "8px 14px", background: "#e3f2fd", borderRadius: 10, fontSize: 12, color: "#1565c0", marginBottom: 14, marginTop: -4 }}>💳 ยอดนี้จะรอเคลียร์จนถึงวันจ่ายบัตร (วันที่ {dueDay})</div>}

          {/* Who paid */}
          <label style={{ fontSize: 13, fontWeight: 700, color: "#b0728a", display: "block", marginBottom: 8 }}>ใครจ่าย{fMode === "itemized" ? "ไปก่อนทั้งบิล" : ""}?</label>
          <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>{[0, 1].map(i => <button key={i} onClick={() => setFP(i)} style={{ flex: 1, padding: 12, borderRadius: 14, border: fP === i ? `2px solid ${pk}` : `2px solid ${pks}`, background: fP === i ? pkl : "white", color: fP === i ? pkd : "#b0728a", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: F }}>{i === 0 ? "💁‍♀️" : "💁‍♂️"} {names[i]}</button>)}</div>

          {/* Split mode toggle */}
          <label style={{ fontSize: 13, fontWeight: 700, color: "#b0728a", display: "block", marginBottom: 8 }}>แบ่งจ่ายแบบไหน?</label>
          <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
            {[{ v: "none", icon: "💰", l: "ไม่แบ่ง", sub: "คนเดียวจ่าย" }, { v: "half", icon: "✂️", l: "หารครึ่ง", sub: "50/50" }, { v: "itemized", icon: "📋", l: "แยกเมนู", sub: "ใส่รายการ" }].map(o => (
              <button key={o.v} onClick={() => setFMode(o.v)} style={{ flex: 1, padding: "10px 4px", borderRadius: 12, border: fMode === o.v ? `2px solid ${pk}` : "2px solid #eee", background: fMode === o.v ? pkl : "white", color: fMode === o.v ? pkd : "#999", fontWeight: 600, fontSize: 11, cursor: "pointer", fontFamily: F, textAlign: "center" }}>
                <div style={{ fontSize: 18, marginBottom: 2 }}>{o.icon}</div>{o.l}<br /><span style={{ fontSize: 10, opacity: .7 }}>{o.sub}</span>
              </button>
            ))}
          </div>

          {/* Normal / Half: simple amount */}
          {fMode !== "itemized" && <>
            <label style={{ fontSize: 13, fontWeight: 700, color: "#b0728a", display: "block", marginBottom: 8 }}>จำนวนเงิน (บาท)</label>
            <input type="number" value={fA} onChange={e => setFA(e.target.value)} placeholder="0" min="0.01" max="9999999" step="0.01" style={{ width: "100%", padding: "14px 16px", borderRadius: 14, border: `2px solid ${pks}`, fontSize: 24, fontWeight: 800, fontFamily: F, color: pkd, textAlign: "center", marginBottom: 4, boxSizing: "border-box", outline: "none" }} />
            {fMode === "half" && fA && S.num(fA) && <p style={{ textAlign: "center", fontSize: 13, color: pk, fontWeight: 600, margin: "0 0 14px" }}>คนละ ฿{fmt(S.num(fA) / 2)}</p>}
            {fMode !== "half" && <div style={{ marginBottom: 14 }} />}
          </>}

          {/* Itemized: items per person + delivery + coupon */}
          {fMode === "itemized" && <>
            {[0, 1].map(pi => (
              <div key={pi} style={{ marginBottom: 14 }}>
                <p style={{ fontSize: 13, fontWeight: 700, color: pi === 0 ? pkd : "#1565c0", margin: "0 0 8px" }}>{pi === 0 ? "💁‍♀️" : "💁‍♂️"} {names[pi]} สั่ง</p>
                {(pi === 0 ? fItems0 : fItems1).map((item, idx) => (
                  <div key={idx} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                    <input value={item.name} placeholder="ชื่อเมนู" maxLength={50} onChange={e => {
                      const fn = pi === 0 ? setFItems0 : setFItems1;
                      fn(prev => { const n = [...prev]; n[idx] = { ...n[idx], name: e.target.value }; return n; });
                    }} style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: `1.5px solid ${pi === 0 ? pks : "#bbdefb"}`, fontSize: 13, fontFamily: F, outline: "none", boxSizing: "border-box" }} />
                    <input type="number" value={item.price} placeholder="฿" onChange={e => {
                      const fn = pi === 0 ? setFItems0 : setFItems1;
                      fn(prev => { const n = [...prev]; n[idx] = { ...n[idx], price: e.target.value }; return n; });
                    }} style={{ width: 75, padding: "10px 8px", borderRadius: 10, border: `1.5px solid ${pi === 0 ? pks : "#bbdefb"}`, fontSize: 13, fontFamily: F, textAlign: "right", outline: "none", boxSizing: "border-box" }} />
                    {(pi === 0 ? fItems0 : fItems1).length > 1 && <button onClick={() => {
                      const fn = pi === 0 ? setFItems0 : setFItems1;
                      fn(prev => prev.filter((_, i) => i !== idx));
                    }} style={{ background: "#fff0f0", border: "none", borderRadius: 8, padding: "0 8px", fontSize: 13, cursor: "pointer", color: "#e57373" }}>✕</button>}
                  </div>
                ))}
                <button onClick={() => { const fn = pi === 0 ? setFItems0 : setFItems1; fn(prev => [...prev, { name: "", price: "" }]); }}
                  style={{ background: "none", border: "none", color: pi === 0 ? pk : "#1565c0", fontSize: 12, cursor: "pointer", fontFamily: F, padding: "4px 0" }}>+ เพิ่มเมนู</button>
              </div>
            ))}

            {/* Delivery + Coupon */}
            <div style={{ borderTop: `1.5px solid ${pks}`, paddingTop: 14, marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 13, color: "#b0728a", minWidth: 55 }}>🚗 ค่าส่ง</span>
                <input type="number" value={fDelivery} onChange={e => setFDelivery(e.target.value)} placeholder="0" style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: `1.5px solid ${pks}`, fontSize: 14, fontFamily: F, textAlign: "right", outline: "none", boxSizing: "border-box" }} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 13, color: "#b0728a", minWidth: 55 }}>🎟️ คูปอง</span>
                <input type="number" value={fCoupon} onChange={e => setFCoupon(e.target.value)} placeholder="0" style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: `1.5px solid ${pks}`, fontSize: 14, fontFamily: F, textAlign: "right", color: "#43a047", outline: "none", boxSizing: "border-box" }} />
              </div>
              {(S.num(fCoupon, 0) || 0) > 0 && <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
                {[{ v: "all", l: "ลดทั้งบิล" }, { v: "0", l: `ลดเฉพาะ ${names[0]}` }, { v: "1", l: `ลดเฉพาะ ${names[1]}` }].map(o => (
                  <button key={o.v} onClick={() => setFCouponType(o.v)} style={{ flex: 1, padding: "8px 2px", borderRadius: 8, border: fCouponType === o.v ? `2px solid ${pk}` : "1.5px solid #eee", background: fCouponType === o.v ? pkl : "white", color: fCouponType === o.v ? pkd : "#999", fontWeight: 600, fontSize: 10, cursor: "pointer", fontFamily: F }}>{o.l}</button>
                ))}
              </div>}
            </div>

            {/* Live summary */}
            {splitCalc && splitCalc.total > 0 && <div style={{ border: `1.5px solid ${pk}`, borderRadius: 14, padding: 14, marginBottom: 14, background: "linear-gradient(135deg,#fff0f3,#fce4ec)" }}>
              <p style={{ fontSize: 12, fontWeight: 700, color: pkd, margin: "0 0 8px", textAlign: "center" }}>📊 สรุปยอด</p>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <div style={{ flex: 1, textAlign: "center" }}>
                  <div style={{ fontSize: 10, color: "#b0728a" }}>💁‍♀️ {names[0]}</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: pkd }}> ฿{fmt(splitCalc.pay0)}</div>
                  <div style={{ fontSize: 9, color: "#cca0b3" }}>{fmt(splitCalc.t0)}+{fmt(splitCalc.delEach)}-{fmt(splitCalc.disc0)}</div>
                </div>
                <div style={{ flex: 1, textAlign: "center" }}>
                  <div style={{ fontSize: 10, color: "#5c6bc0" }}>💁‍♂️ {names[1]}</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: "#1565c0" }}>฿{fmt(splitCalc.pay1)}</div>
                  <div style={{ fontSize: 9, color: "#90a4ae" }}>{fmt(splitCalc.t1)}+{fmt(splitCalc.delEach)}-{fmt(splitCalc.disc1)}</div>
                </div>
              </div>
              <div style={{ padding: "8px 12px", background: "#fff8e1", borderRadius: 10, textAlign: "center", fontSize: 12, fontWeight: 700, color: "#e65100" }}>
                {fP === 0 ? "💁‍♀️" : "💁‍♂️"} {names[fP]} จ่ายไปก่อน ฿{fmt(splitCalc.total)} → {fP === 0 ? "💁‍♂️" : "💁‍♀️"} {names[splitCalc.otherPerson]} ต้องโอนคืน <span style={{ fontSize: 14 }}>฿{fmt(splitCalc.oweAmount)}</span>
              </div>
            </div>}
          </>}

          {/* Note */}
          <label style={{ fontSize: 13, fontWeight: 700, color: "#b0728a", display: "block", marginBottom: 8 }}>รายละเอียด</label>
          <input value={fN} onChange={e => setFN(e.target.value)} placeholder={fMode === "itemized" ? "เช่น LINE MAN วันนี้" : "เช่น ค่าข้าวกลางวัน"} maxLength={100} style={{ width: "100%", padding: "12px 16px", borderRadius: 14, border: `2px solid ${pks}`, fontSize: 15, fontFamily: F, marginBottom: 18, boxSizing: "border-box", outline: "none" }} />

          {/* Category */}
          <label style={{ fontSize: 13, fontWeight: 700, color: "#b0728a", display: "block", marginBottom: 8 }}>หมวดหมู่</label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: 18 }}>{CATS.map(c => <button key={c.id} onClick={() => setFC(c.id)} style={{ padding: "10px 8px", borderRadius: 12, border: fC === c.id ? `2px solid ${pk}` : "2px solid #eee", background: fC === c.id ? pkl : "white", color: fC === c.id ? pkd : "#888", fontWeight: 600, fontSize: 12, cursor: "pointer", fontFamily: F }}>{c.e} {c.l}</button>)}</div>

          {/* Receipt */}
          <label style={{ fontSize: 13, fontWeight: 700, color: "#b0728a", display: "block", marginBottom: 8 }}>แนบรูปบิล (สูงสุด {MAX_IMG}MB)</label>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={handleFile} style={{ display: "none" }} />
          {fR ? <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}><img src={fR} style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 12 }} /><button onClick={() => setFR(null)} style={{ background: "#fff0f0", border: "none", color: "#e57373", padding: "8px 14px", borderRadius: 10, fontSize: 13, cursor: "pointer", fontFamily: F, fontWeight: 600 }}>ลบรูป</button></div> : <button onClick={() => fileRef.current?.click()} style={{ width: "100%", padding: 12, borderRadius: 14, border: `2px dashed ${pks}`, background: "transparent", color: "#b0728a", fontSize: 14, cursor: "pointer", fontFamily: F, marginBottom: 18 }}>📷 กดเพื่อแนบรูป</button>}

          {/* Submit */}
          <button onClick={addTx} style={{ ...bt(true), width: "100%", padding: 16 }}>บันทึกรายการ 💖</button>
        </div>
      </div>}

      <style>{`
        @keyframes popIn{0%{transform:translateX(-50%) scale(.8);opacity:0}100%{transform:translateX(-50%) scale(1);opacity:1}}
        @keyframes slideUp{0%{transform:translateY(100%)}100%{transform:translateY(0)}}
        @keyframes floatUp{0%{transform:translateY(0) rotate(0);opacity:0}10%{opacity:1}90%{opacity:1}100%{transform:translateY(-110vh) rotate(25deg);opacity:0}}
        @keyframes shakeX{0%,100%{transform:translateX(0)}20%{transform:translateX(-10px)}40%{transform:translateX(10px)}60%{transform:translateX(-6px)}80%{transform:translateX(6px)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        input:focus{border-color:${pk} !important;box-shadow:0 0 0 3px rgba(232,98,140,.12)}
        *{-webkit-tap-highlight-color:transparent}::-webkit-scrollbar{width:0}
      `}</style>
    </div>
  );
}
