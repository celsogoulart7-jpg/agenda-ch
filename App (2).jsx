import { useState, useRef } from "react";

function formatForGoogleCalendar(event) {
  const pad = (n) => String(n).padStart(2, "0");
  const parseDate = (dateStr, timeStr) => {
    if (!dateStr) return null;
    const cleanDate = dateStr.replace(/[^\d\/\-\.]/g, "");
    const cleanTime = timeStr ? timeStr.replace(/[^\d:]/g, "") : "00:00";
    let day, month, year;
    const dmyMatch = cleanDate.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
    const ymdMatch = cleanDate.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/);
    if (dmyMatch) { day = +dmyMatch[1]; month = +dmyMatch[2]; year = +dmyMatch[3]; }
    else if (ymdMatch) { year = +ymdMatch[1]; month = +ymdMatch[2]; day = +ymdMatch[3]; }
    else return null;
    // Se o ano não foi identificado (ex: data sem ano), usa o ano atual
    if (!year || year < 2000) year = new Date().getFullYear();
    const [hh, mm] = cleanTime.split(":").map(Number);
    // Build directly from parts — avoids UTC timezone shift
    return `${year}${pad(month)}${pad(day)}T${pad(hh || 0)}${pad(mm || 0)}00`;
  };
  const start = parseDate(event.date, event.startTime);
  const end = parseDate(event.endDate || event.date, event.endTime || event.startTime);
  const params = new URLSearchParams();
  params.set("action", "TEMPLATE");
  params.set("text", event.title || "Evento");
  if (start) {
    const endStr = end && end !== start ? end : (() => {
      const h = parseInt(start.slice(9, 11));
      return start.slice(0, 9) + String(h + 1).padStart(2, "0") + start.slice(11);
    })();
    params.set("dates", `${start}/${endStr}`);
  }
  if (event.location) params.set("location", event.location);
  const details = [
    event.description,
    event.organizer ? `Organizador: ${event.organizer}` : null,
    event.link ? `Link: ${event.link}` : null,
  ].filter(Boolean).join("\n");
  if (details) params.set("details", details);
  params.set("authuser", "ch22agenda@gmail.com");
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.eml,.ics";

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(",")[1]);
    r.onerror = () => rej(new Error("Leitura falhou"));
    r.readAsDataURL(file);
  });
}

function getMediaType(file) {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop().toLowerCase();
  const map = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", txt: "text/plain", eml: "text/plain", ics: "text/plain" };
  return map[ext] || "application/octet-stream";
}

export default function App() {
  const [inputMode, setInputMode] = useState("text");
  const [text, setText] = useState("");
  const [file, setFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [status, setStatus] = useState("idle");
  const [event, setEvent] = useState(null);
  const [error, setError] = useState("");
  const [calendarUrl, setCalendarUrl] = useState("");
  const fileRef = useRef();

  const hasInput = inputMode === "text" ? text.trim().length > 0 : file !== null;

  const handleFile = (f) => { if (!f) return; setFile(f); setError(""); };
  const handleDrop = (e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); };

  const buildMessages = async () => {
    const prompt = `Extraia os dados do seguinte convite de evento e retorne APENAS um objeto JSON válido (sem markdown, sem explicações) com os campos:
- title (string): nome/título do evento
- date (string): data no formato DD/MM/AAAA
- endDate (string ou null): data de término se diferente, DD/MM/AAAA
- startTime (string ou null): horário de início, HH:MM
- endTime (string ou null): horário de término, HH:MM
- location (string ou null): local, endereço ou link de reunião online
- description (string ou null): descrição ou pauta resumida
- organizer (string ou null): nome do organizador ou empresa
- link (string ou null): link de participação se houver`;

    if (inputMode === "text") {
      return [{ role: "user", content: `${prompt}\n\nConvite:\n${text}` }];
    }
    const mediaType = getMediaType(file);
    const base64 = await fileToBase64(file);
    if (mediaType === "application/pdf") {
      return [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }, { type: "text", text: prompt }] }];
    } else if (mediaType.startsWith("image/")) {
      return [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: mediaType, data: base64 } }, { type: "text", text: prompt }] }];
    } else {
      const decoded = atob(base64);
      return [{ role: "user", content: `${prompt}\n\nConvite:\n${decoded}` }];
    }
  };

  const extract = async () => {
    setStatus("loading"); setError(""); setEvent(null);
    try {
      const messages = await buildMessages();
      // Calls our Netlify serverless function — API key is stored server-side
      const response = await fetch("/api/claude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, messages }),
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error);
      const raw = data.content?.map((b) => b.text || "").join("") || "";
      const clean = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      setEvent(parsed);
      setCalendarUrl(formatForGoogleCalendar(parsed));
      setStatus("done");
    } catch (e) {
      console.error(e);
      setError("Não foi possível extrair os dados. Verifique se o arquivo contém informações de evento.");
      setStatus("error");
    }
  };

  const reset = () => { setText(""); setFile(null); setEvent(null); setStatus("idle"); setError(""); setCalendarUrl(""); };

  return (
    <div style={S.page}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
        .tab-btn { transition: all 0.18s; }
        .tab-btn:hover { opacity: 0.85; }
        .drop-zone { transition: border-color 0.2s, background 0.2s; }
      `}</style>
      <div style={S.card}>

        {/* Logo header */}
        <div style={S.logoHeader}>
          <img src="/logo.png" alt="Carlos Humberto - Deputado Estadual" style={S.logo} />
        </div>
        <div style={S.divider} />
        <p style={S.subtitle2}>Cole o texto ou envie um arquivo — adicione direto ao Google Calendar</p>

        {status !== "done" && (
          <>
            <div style={S.tabs}>
              <button className="tab-btn" style={{ ...S.tab, ...(inputMode === "text" ? S.tabActive : {}) }} onClick={() => { setInputMode("text"); setError(""); }}>
                ✏️ Colar texto
              </button>
              <button className="tab-btn" style={{ ...S.tab, ...(inputMode === "file" ? S.tabActive : {}) }} onClick={() => { setInputMode("file"); setError(""); }}>
                📎 Enviar arquivo
              </button>
            </div>

            {inputMode === "text" && (
              <textarea
                style={S.textarea}
                placeholder="Cole aqui o e-mail, mensagem de WhatsApp, texto de convite ou qualquer texto com informações do evento..."
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={9}
              />
            )}

            {inputMode === "file" && (
              <>
                <div
                  className="drop-zone"
                  style={{ ...S.dropZone, ...(dragOver ? S.dropZoneActive : {}), ...(file ? S.dropZoneHasFile : {}) }}
                  onClick={() => !file && fileRef.current.click()}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                >
                  {file ? (
                    <div style={S.filePreview}>
                      <span style={S.fileIcon}>{getFileEmoji(file.name)}</span>
                      <div style={S.fileInfo}>
                        <div style={S.fileName}>{file.name}</div>
                        <div style={S.fileSize}>{(file.size / 1024).toFixed(1)} KB</div>
                      </div>
                      <button style={S.removeFile} onClick={(e) => { e.stopPropagation(); setFile(null); }}>✕</button>
                    </div>
                  ) : (
                    <div style={S.dropContent}>
                      <div style={S.uploadIcon}>
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                          <path d="M12 16V8M12 8l-3 3M12 8l3 3" stroke="#9CA3AF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                          <rect x="3" y="14" width="18" height="7" rx="2" stroke="#9CA3AF" strokeWidth="1.8"/>
                        </svg>
                      </div>
                      <div style={S.dropText}>Arraste um arquivo ou <span style={S.dropLink}>clique para selecionar</span></div>
                      <div style={S.dropHint}>PDF, imagem (PNG, JPG), .eml, .ics ou .txt</div>
                    </div>
                  )}
                </div>
                <input ref={fileRef} type="file" accept={ACCEPT} style={{ display: "none" }} onChange={(e) => handleFile(e.target.files[0])} />
              </>
            )}

            {status === "error" && <div style={S.errorBox}>⚠️ {error}</div>}

            <button
              style={{ ...S.btn, opacity: !hasInput || status === "loading" ? 0.5 : 1 }}
              onClick={extract}
              disabled={!hasInput || status === "loading"}
            >
              {status === "loading" ? (
                <span style={S.loadingInner}><Spinner /> Extraindo dados...</span>
              ) : "✨ Extrair e preparar evento"}
            </button>
          </>
        )}

        {status === "done" && event && (
          <div style={{ animation: "fadeIn 0.3s ease" }}>
            <div style={S.resultHeader}>
              <span style={S.tag}>Dados extraídos</span>
              <button style={S.resetBtn} onClick={reset}>← Novo convite</button>
            </div>
            <h2 style={S.eventTitle}>{event.title}</h2>
            <div style={S.fields}>
              {event.date && <Field icon="📅" label="Data" value={[event.date, event.endDate && event.endDate !== event.date ? `até ${event.endDate}` : null].filter(Boolean).join(" ")} />}
              {(event.startTime || event.endTime) && <Field icon="🕐" label="Horário" value={[event.startTime, event.endTime ? `às ${event.endTime}` : null].filter(Boolean).join(" ")} />}
              {event.location && <Field icon="📍" label="Local" value={event.location} />}
              {event.organizer && <Field icon="👤" label="Organizador" value={event.organizer} />}
              {event.description && <Field icon="📋" label="Descrição" value={event.description} />}
              {event.link && <Field icon="🔗" label="Link" value={event.link} isLink />}
            </div>
            {!event.date && (
              <div style={S.warnBox}>⚠️ Não foi possível identificar a data. Você poderá ajustar diretamente no Google Calendar.</div>
            )}
            <a href={calendarUrl} target="_blank" rel="noopener noreferrer" style={S.gcalBtn}>
              <GoogleCalIcon /> Adicionar ao Google Calendar
            </a>
            <p style={S.hint}>Você será redirecionado ao Google Calendar com os dados pré-preenchidos. Revise antes de salvar.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function getFileEmoji(name) {
  const ext = name.split(".").pop().toLowerCase();
  if (ext === "pdf") return "📄";
  if (["png","jpg","jpeg","gif","webp"].includes(ext)) return "🖼️";
  if (ext === "eml") return "📧";
  if (ext === "ics") return "📅";
  return "📝";
}

function Field({ icon, label, value, isLink }) {
  return (
    <div style={S.field}>
      <span style={S.fieldIcon}>{icon}</span>
      <div>
        <div style={S.fieldLabel}>{label}</div>
        {isLink
          ? <a href={value} target="_blank" rel="noopener noreferrer" style={S.fieldLink}>{value}</a>
          : <div style={S.fieldValue}>{value}</div>}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ animation: "spin 0.8s linear infinite" }}>
      <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.3)" strokeWidth="3"/>
      <path d="M12 2a10 10 0 0 1 10 10" stroke="white" strokeWidth="3" strokeLinecap="round"/>
    </svg>
  );
}

function GoogleCalIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" style={{ marginRight: 8 }}>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="white"/>
      <rect x="3" y="3" width="18" height="5" fill="#4285F4"/>
      <path d="M8 11h3v3H8z" fill="#34A853"/>
      <path d="M13 11h3v3h-3z" fill="#FBBC05"/>
      <path d="M8 15h3v3H8z" fill="#EA4335"/>
      <path d="M13 15h3v3h-3z" fill="#4285F4"/>
    </svg>
  );
}

const S = {
  page: { minHeight:"100vh", background:"linear-gradient(135deg,#EEF2FF 0%,#F0F9FF 100%)", display:"flex", alignItems:"flex-start", justifyContent:"center", padding:"32px 16px", fontFamily:"'Inter',system-ui,-apple-system,sans-serif" },
  card: { background:"white", borderRadius:20, boxShadow:"0 4px 32px rgba(0,0,0,0.08)", padding:"32px", width:"100%", maxWidth:580 },
  logoHeader: { display:"flex", alignItems:"center", justifyContent:"center", marginBottom:16 },
  logo: { height:56, width:"auto", objectFit:"contain", display:"block" },
  divider: { height:1, background:"#f0f0f0", marginBottom:14 },
  subtitle2: { fontSize:13, color:"#6b7280", marginBottom:18, lineHeight:1.4, textAlign:"center" },
  tabs: { display:"flex", gap:8, marginBottom:16 },
  tab: { flex:1, padding:"9px 12px", border:"1.5px solid #e5e7eb", borderRadius:10, fontSize:13, fontWeight:500, color:"#6b7280", background:"white", cursor:"pointer" },
  tabActive: { borderColor:"#6366F1", color:"#6366F1", background:"#EEF2FF", fontWeight:600 },
  textarea: { width:"100%", boxSizing:"border-box", border:"1.5px solid #e5e7eb", borderRadius:12, padding:"14px 16px", fontSize:14, color:"#111827", lineHeight:1.6, resize:"vertical", outline:"none", fontFamily:"inherit", background:"#fafafa" },
  dropZone: { border:"2px dashed #d1d5db", borderRadius:14, padding:"32px 20px", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", background:"#fafafa", minHeight:140 },
  dropZoneActive: { borderColor:"#6366F1", background:"#EEF2FF" },
  dropZoneHasFile: { cursor:"default", borderStyle:"solid", borderColor:"#e5e7eb", background:"white" },
  dropContent: { textAlign:"center" },
  uploadIcon: { marginBottom:10, display:"flex", justifyContent:"center" },
  dropText: { fontSize:14, color:"#374151", marginBottom:4 },
  dropLink: { color:"#6366F1", fontWeight:600 },
  dropHint: { fontSize:12, color:"#9CA3AF" },
  filePreview: { display:"flex", alignItems:"center", gap:12, width:"100%" },
  fileIcon: { fontSize:28, flexShrink:0 },
  fileInfo: { flex:1, minWidth:0 },
  fileName: { fontSize:14, fontWeight:600, color:"#111827", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  fileSize: { fontSize:12, color:"#9CA3AF", marginTop:2 },
  removeFile: { background:"none", border:"none", fontSize:16, color:"#9CA3AF", cursor:"pointer", padding:"4px", flexShrink:0 },
  btn: { width:"100%", marginTop:16, padding:"14px", background:"linear-gradient(135deg,#4F8EF7,#6366F1)", color:"white", border:"none", borderRadius:12, fontSize:15, fontWeight:600, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:8 },
  loadingInner: { display:"flex", alignItems:"center", gap:8 },
  errorBox: { marginTop:12, padding:"10px 14px", background:"#FEF2F2", border:"1px solid #FECACA", borderRadius:10, fontSize:13, color:"#DC2626" },
  resultHeader: { display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 },
  tag: { fontSize:11, fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase", color:"#6366F1", background:"#EEF2FF", padding:"4px 10px", borderRadius:20 },
  resetBtn: { background:"none", border:"none", fontSize:13, color:"#6b7280", cursor:"pointer", padding:0 },
  eventTitle: { margin:"0 0 18px", fontSize:20, fontWeight:700, color:"#111827", lineHeight:1.3 },
  fields: { display:"flex", flexDirection:"column", gap:10, marginBottom:20 },
  field: { display:"flex", gap:12, padding:"12px 14px", background:"#F9FAFB", borderRadius:10, alignItems:"flex-start" },
  fieldIcon: { fontSize:16, marginTop:1, flexShrink:0 },
  fieldLabel: { fontSize:11, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.05em", color:"#9CA3AF", marginBottom:2 },
  fieldValue: { fontSize:14, color:"#111827", lineHeight:1.5 },
  fieldLink: { fontSize:13, color:"#4F8EF7", wordBreak:"break-all" },
  warnBox: { padding:"10px 14px", background:"#FFFBEB", border:"1px solid #FDE68A", borderRadius:10, fontSize:13, color:"#92400E", marginBottom:16 },
  gcalBtn: { display:"flex", alignItems:"center", justifyContent:"center", width:"100%", boxSizing:"border-box", padding:"14px", background:"#4285F4", color:"white", borderRadius:12, textDecoration:"none", fontSize:15, fontWeight:600 },
  hint: { textAlign:"center", fontSize:12, color:"#9CA3AF", marginTop:10, marginBottom:0 },
};
