// ═══════════════════════════════════════════
// ANALYTICS MODULE
// ═══════════════════════════════════════════
// ═══════════════════════════════════════════
// 📊 提前統計（週報／月報，可選 AI 分析）
// admin(role='admin'或'editor'，目前是麒/Hanna)：看全部師傅的數據，維持原本行為
// 一般師傅(泓文/哲瑋/治)：只看/只推播自己的數據，AI分析也只針對自己
// ═══════════════════════════════════════════
function QuickReportPanel({ isAdmin, currentMaster }) {
  const [busy, setBusy] = React.useState(null); // 'week' | 'week-ai' | 'month' | 'month-ai' | null
  const [lastMsg, setLastMsg] = React.useState(null);
  const [showResult, setShowResult] = React.useState(false);
  const runningRef = React.useRef(false); // ref同步生效，比state更早鎖住，防止手速快/畫面重繪延遲時重複觸發

  const run = async (kind, withAI) => {
    if (runningRef.current) return; // 已經有一個在跑了，直接擋掉，不管state有沒有跟上
    runningRef.current = true;
    setBusy(withAI ? `${kind}-ai` : kind);
    try {
      let reportText, error;
      if (isAdmin) {
        const rpcName = kind === "week" ? "send_weekly_settlement_report" : "send_monthly_settlement_report";
        ({ data: reportText, error } = await sb.rpc(rpcName));
      } else {
        ({ data: reportText, error } = await sb.rpc("send_my_settlement_report", { p_master_id: currentMaster.id, p_period: kind }));
      }
      if (error) { alert("報表產生失敗：" + error.message); return; }

      let aiText = null;
      if (withAI) {
        try {
          const today = getTaipeiNow();
          const startDate = kind === "week"
            ? (() => { const d = new Date(today); d.setDate(d.getDate() - d.getDay()); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })()
            : `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
          const endDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
          const reqBody = { startDate, endDate };
          if (!isAdmin) reqBody.masterId = currentMaster.id;
          const resp = await fetch("https://ikzyzkhuireqztbhrtna.supabase.co/functions/v1/generate-monthly-analysis", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(reqBody)
          });
          const result = await resp.json();
          if (result.success) aiText = result.message;
        } catch (e) { /* AI 分析失敗不影響數字報表已經送出 */ }
      }

      setLastMsg({ report: reportText, ai: aiText });
      setShowResult(true);
    } finally {
      setBusy(null);
      runningRef.current = false;
    }
  };

  const btnStyle = (color, kind) => ({
    flex: 1, padding: "9px 4px", borderRadius: 10, border: `1px solid ${color}`,
    background: "none", color, fontWeight: 700, fontSize: 12,
    cursor: busy ? "wait" : "pointer", opacity: busy && busy !== kind ? 0.4 : 1
  });

  return /*#__PURE__*/React.createElement("div", { style: { padding: "12px 12px 0", borderBottom: "1px solid var(--border)", marginBottom: 12 } },
    /*#__PURE__*/React.createElement("div", { style: { fontWeight: 900, fontSize: 14, marginBottom: 8 } }, "📊 提前統計"),
    /*#__PURE__*/React.createElement("div", { style: { fontSize: 11, color: "var(--text-dim)", marginBottom: 10 } },
      isAdmin ? "不用等自動排程，現在就送出數字報表（會推播給管理員），要不要一起跑AI分析直接選對應按鈕。" : "只會統計並推播給你自己的數據，不含其他師傅，要不要一起跑AI分析直接選對應按鈕。"),
    busy && busy.endsWith("-ai") && /*#__PURE__*/React.createElement("div", { style: { fontSize: 11, color: "#f5a623", marginBottom: 10, fontWeight: 700 } }, "⏳ AI分析需要15-20秒左右，畫面沒動不代表卡住，請耐心等待、不要重複點擊或重新整理"),
    /*#__PURE__*/React.createElement("div", { style: { fontSize: 10, color: "var(--text-dim)", marginBottom: 4, fontWeight: 700 } }, "本週"),
    /*#__PURE__*/React.createElement("div", { style: { display: "flex", gap: 6, marginBottom: 10 } },
      /*#__PURE__*/React.createElement("button", {
        onClick: () => run("week", false), disabled: !!busy,
        style: btnStyle("#74b9ff", "week")
      }, busy === "week" ? "統計中..." : "只送數字"),
      /*#__PURE__*/React.createElement("button", {
        onClick: () => run("week", true), disabled: !!busy,
        style: btnStyle("#74b9ff", "week-ai")
      }, busy === "week-ai" ? "統計中..." : "數字＋AI分析")
    ),
    /*#__PURE__*/React.createElement("div", { style: { fontSize: 10, color: "var(--text-dim)", marginBottom: 4, fontWeight: 700 } }, "本月（至今）"),
    /*#__PURE__*/React.createElement("div", { style: { display: "flex", gap: 6, marginBottom: 12 } },
      /*#__PURE__*/React.createElement("button", {
        onClick: () => run("month", false), disabled: !!busy,
        style: btnStyle("#a29bfe", "month")
      }, busy === "month" ? "統計中..." : "只送數字"),
      /*#__PURE__*/React.createElement("button", {
        onClick: () => run("month", true), disabled: !!busy,
        style: btnStyle("#a29bfe", "month-ai")
      }, busy === "month-ai" ? "統計中..." : "數字＋AI分析")
    ),
    showResult && lastMsg && /*#__PURE__*/React.createElement("div", {
      style: { position: "fixed", inset: 0, background: "rgba(0,0,0,.7)", zIndex: 999, display: "flex", alignItems: "flex-end", justifyContent: "center" },
      onClick: () => setShowResult(false)
    }, /*#__PURE__*/React.createElement("div", {
      style: { background: "var(--bg-header)", borderRadius: "20px 20px 0 0", padding: "20px 18px 32px", width: "100%", maxWidth: 480, maxHeight: "80vh", overflowY: "auto" },
      onClick: e => e.stopPropagation()
    },
      /*#__PURE__*/React.createElement("div", { style: { fontWeight: 900, fontSize: 15, marginBottom: 10 } }, isAdmin ? "✓ 已推播給管理員" : "✓ 已推播給你"),
      /*#__PURE__*/React.createElement("pre", { style: { whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: 13, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 10, padding: 12, marginBottom: lastMsg.ai ? 10 : 16 } }, lastMsg.report),
      lastMsg.ai && /*#__PURE__*/React.createElement("pre", { style: { whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: 13, background: "rgba(162,155,254,0.1)", border: "1px solid #a29bfe", borderRadius: 10, padding: 12, marginBottom: 16 } }, lastMsg.ai),
      /*#__PURE__*/React.createElement("button", {
        onClick: () => setShowResult(false),
        style: { width: "100%", padding: 12, borderRadius: 10, border: "1.5px solid var(--border)", background: "none", color: "var(--text-dim)", fontSize: 14, cursor: "pointer" }
      }, "關閉")
    ))
  );
}
window.AnalyticsModule = function AnalyticsModule({
  masters,
  FS,
  currentMaster,
  isAdmin
}) {
  const today = getTaipeiNow();
  // 數據模組用獨立的師傅清單（不受 is_active 過濾）
  const [allMasters, setAllMasters] = useState(masters);
  useEffect(() => {
    sb.from("masters").select("*").neq("role", "editor").then(({
      data
    }) => {
      if (data && data.length > 0) {
        const ORDER2 = ["麒", "治", "泓文", "哲瑋"];
        const sorted = [...ORDER2.map(name => data.find(m => m.name === name)).filter(Boolean), ...data.filter(m => !ORDER2.includes(m.name))];
        setAllMasters(sorted);
      }
    });
  }, []);
  const ORDER = ["麒", "治", "泓文", "哲瑋"];
  const activeMasters = allMasters.length > 0 ? allMasters : [...ORDER.map(name => masters.find(m => m.name === name && m.role !== "editor")).filter(Boolean), ...masters.filter(m => m.role !== "editor" && !ORDER.includes(m.name))];
  const [anaTab, setAnaTab] = useState("master");
  const [selMasterId, setSelMasterId] = useState(null);
  const [year, setYear] = useState(today.getFullYear());
  const [yearA, setYearA] = useState(today.getFullYear() - 1);
  const [yearB, setYearB] = useState(today.getFullYear());
  const [allData, setAllData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [detailMonth, setDetailMonth] = useState(today.getMonth());
  // 2026-07-12新增：讓「每日明細」正在瀏覽的月份也能直接跑AI分析，不用
  // 只能對「本週/本月至今」這兩個寫死的區間——切到哪個月，分析哪個月。
  const [monthAiBusy, setMonthAiBusy] = useState(false);
  const [monthAiResult, setMonthAiResult] = useState(null);
  const runMonthAI = async () => {
    if (monthAiBusy) return;
    setMonthAiBusy(true);
    setMonthAiResult(null);
    try {
      const lastDay = new Date(year, detailMonth + 1, 0).getDate();
      const isCurrentMonth = year === today.getFullYear() && detailMonth === today.getMonth();
      const endDay = isCurrentMonth ? today.getDate() : lastDay; // 當月只分析到今天，避免把還沒發生的未來天數也算進去
      const startDate = `${year}-${String(detailMonth + 1).padStart(2, "0")}-01`;
      const endDate = `${year}-${String(detailMonth + 1).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`;
      const resp = await fetch("https://ikzyzkhuireqztbhrtna.supabase.co/functions/v1/generate-monthly-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startDate, endDate, masterId: selMasterId, pushToAdmins: false })
      });
      const result = await resp.json();
      if (result.success) {
        setMonthAiResult({ text: result.analysis, startDate, endDate });
      } else {
        setMonthAiResult({ error: result.error || "分析失敗" });
      }
    } catch (e) {
      setMonthAiResult({ error: String(e?.message || e) });
    } finally {
      setMonthAiBusy(false);
    }
  };
  useEffect(() => {
    setMonthAiResult(null); // 切月份/切師傅/切年份時，上一次的分析結果就跟畫面對不上了，清掉避免誤會
  }, [detailMonth, selMasterId, year]);

  const yearsNeeded = useMemo(() => [...new Set([year, yearA, yearB])], [year, yearA, yearB]);
  useEffect(() => {
    if (activeMasters.length > 0 && !selMasterId) {
      const cmInList = currentMaster && activeMasters.find(m => m.id === currentMaster.id);
      setSelMasterId(cmInList ? currentMaster.id : activeMasters[0].id);
    }
  }, [activeMasters.length]);
  useEffect(() => {
    setLoading(true);
    const fetchYear = async y => {
      let all = [],
        from = 0;
      while (true) {
        const {
          data
        } = await sb.from("bookings").select("master_id,date,guest_count,color_tag,customer_phone,customer_name,status").gte("date", `${y}-01-01`).lte("date", `${y}-12-31`).neq("status", "cancelled").neq("status", "no_show").range(from, from + 999);
        if (!data || data.length === 0) break;
        all = [...all, ...data];
        if (data.length < 1000) break;
        from += 1000;
      }
      return all;
    };
    Promise.all(yearsNeeded.map(fetchYear)).then(results => {
      setAllData(results.flat());
      setLoading(false);
    });
  }, [yearsNeeded.join(",")]);
  const calcStat = (masterId, y, m) => {
    const prefix = `${y}-${String(m + 1).padStart(2, "0")}`;
    const vacDates = new Set(allData.filter(b => b.master_id === masterId && b.date.startsWith(prefix) && b.color_tag === "vacation").map(b => b.date));
    // 只算使用者真的有寫名字的；卡位/自訂預設值、休假、售後 都不算
    const bks = allData.filter(b => b.master_id === masterId && b.date.startsWith(prefix) && isCountable(b));
    const total = bks.reduce((s, b) => s + (b.guest_count || 1), 0);
    const newC = bks.filter(b => b.color_tag === "new_customer").reduce((s, b) => s + (b.guest_count || 1), 0);
    const vacDays = vacDates.size;
    return {
      total,
      newC,
      old: total - newC,
      vacDays
    };
  };
  const calcYearStat = (masterId, y) => {
    let total = 0,
      newC = 0,
      vac = 0;
    for (let m = 0; m < 12; m++) {
      const s = calcStat(masterId, y, m);
      total += s.total;
      newC += s.newC;
      vac += s.vacDays;
    }
    return {
      total,
      newC,
      old: total - newC,
      vac
    };
  };
  const getDayStats = (masterId, y, m) => {
    const days = new Date(y, m + 1, 0).getDate();
    return Array.from({
      length: days
    }, (_, i) => {
      const d = i + 1;
      const dateStr = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      // 只算使用者真的有寫名字的；卡位/自訂預設值、休假、售後 都不算
      const bks = allData.filter(b => b.master_id === masterId && b.date === dateStr && isCountable(b));
      const hasVac = allData.some(b => b.master_id === masterId && b.date === dateStr && b.color_tag === "vacation");
      const dayTotal = bks.reduce((s, b) => s + (b.guest_count || 1), 0);
      const dayNewC = bks.filter(b => b.color_tag === "new_customer").reduce((s, b) => s + (b.guest_count || 1), 0);
      // 只有沒有任何真實客人且有vacation紀錄才顯示休假
      const isVac = hasVac && dayTotal === 0;
      return {
        d,
        total: dayTotal,
        newC: dayNewC,
        isVac
      };
    });
  };
  const [debugInfo, setDebugInfo] = useState(null);
  useModalBackClose(!!debugInfo, React.useCallback(() => setDebugInfo(null), []));
  const showDebug = (masterId, y, m) => {
    const prefix = `${y}-${String(m + 1).padStart(2, "0")}`;
    const all = allData.filter(b => b.master_id === masterId && b.date.startsWith(prefix));
    const counted = all.filter(b => isCountable(b));
    const excluded = all.filter(b => !isCountable(b));
    setDebugInfo({
      y,
      m,
      all: all.length,
      counted: counted.length,
      excluded
    });
  };
  const selMaster = activeMasters.find(m => m.id === selMasterId) || activeMasters[0];
  const TC = {
    fontSize: 11,
    padding: "5px 6px",
    textAlign: "center",
    border: "1px solid var(--border)",
    color: "var(--text-main)"
  };
  const TH = {
    ...TC,
    background: "var(--bg-sub)",
    fontWeight: 700,
    color: "var(--text-muted)",
    fontSize: 10
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      paddingBottom: 140,
      flex: 1,
      overflow: "auto"
    }
  }, /*#__PURE__*/React.createElement(QuickReportPanel, { isAdmin, currentMaster }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      background: "var(--bg-header)",
      borderBottom: "1px solid var(--border2)",
      overflowX: "auto"
    }
  }, [["master", "個人明細"], ["summary", "月度總表"], ["yearly", "全年對比"]].map(([k, l]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    className: `tab-btn${anaTab === k ? " active" : ""}`,
    onClick: () => setAnaTab(k)
  }, l)), loading && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      color: "var(--text-dim)",
      padding: "0 10px",
      alignSelf: "center"
    }
  }, "載入中...")), anaTab === "master" && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "8px 12px",
      background: "var(--bg-header)",
      borderBottom: "1px solid var(--border)",
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setYear(y => y - 1),
    className: "nb"
  }, "◀"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 700,
      fontSize: 14
    }
  }, year, "年"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setYear(y => y + 1),
    className: "nb"
  }, "▶"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 5,
      flexWrap: "wrap",
      marginLeft: 8
    }
  }, activeMasters.map(m => /*#__PURE__*/React.createElement("button", {
    key: m.id,
    onClick: () => setSelMasterId(m.id),
    style: {
      padding: "3px 12px",
      borderRadius: 16,
      border: `1px solid ${selMasterId === m.id ? "#e94560" : "var(--border2)"}`,
      background: selMasterId === m.id ? "#e9456022" : "transparent",
      color: selMasterId === m.id ? "#e94560" : "var(--text-muted)",
      fontSize: 12,
      cursor: "pointer",
      fontWeight: selMasterId === m.id ? 700 : 400
    }
  }, m.name)))), selMaster && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      overflowX: "auto",
      padding: "12px 12px 4px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      color: "var(--text-muted)",
      marginBottom: 8
    }
  }, selMaster.name, " — ", year, "年 每月總覽"), /*#__PURE__*/React.createElement("table", {
    style: {
      borderCollapse: "collapse",
      width: "100%",
      minWidth: 600
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      ...TH,
      textAlign: "left",
      minWidth: 50
    }
  }, "月份"), MONTHS.map((ml, i) => /*#__PURE__*/React.createElement("th", {
    key: i,
    style: {
      ...TH,
      minWidth: 48
    }
  }, ml)), /*#__PURE__*/React.createElement("th", {
    style: {
      ...TH,
      background: "var(--bg-week)",
      color: "#74b9ff",
      minWidth: 55
    }
  }, "全年"))), /*#__PURE__*/React.createElement("tbody", null, [["總客", "#74b9ff", "total"], ["新客", "#f5a623", "newC"], ["舊客", "#00b894", "old"]].map(([label, color, key]) => /*#__PURE__*/React.createElement("tr", {
    key: label
  }, /*#__PURE__*/React.createElement("td", {
    style: {
      ...TC,
      fontWeight: 700,
      color,
      textAlign: "left",
      background: "var(--bg-sub)"
    }
  }, label), MONTHS.map((_, mi) => {
    const s = calcStat(selMasterId, year, mi);
    const val = s[key];
    return /*#__PURE__*/React.createElement("td", {
      key: mi,
      style: {
        ...TC,
        color: val > 0 ? color : "var(--text-dim)",
        fontWeight: val > 0 ? 700 : 400
      }
    }, val || "—");
  }), /*#__PURE__*/React.createElement("td", {
    style: {
      ...TC,
      background: "var(--bg-week)",
      fontWeight: 800,
      color,
      fontSize: 12
    }
  }, calcYearStat(selMasterId, year)[key] || "—")))))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "8px 12px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      marginBottom: 8,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      color: "var(--text-muted)"
    }
  }, selMaster.name, " — 每日明細"), /*#__PURE__*/React.createElement("button", {
    onClick: () => showDebug(selMasterId, year, detailMonth),
    style: {
      padding: "2px 8px",
      borderRadius: 12,
      border: "1px solid #f5a62360",
      background: "transparent",
      color: "#f5a623",
      fontSize: 10,
      cursor: "pointer",
      fontFamily: "inherit"
    }
  }, "🔍 檢查未計入紀錄"), /*#__PURE__*/React.createElement("button", {
    onClick: runMonthAI,
    disabled: monthAiBusy,
    style: {
      padding: "2px 8px",
      borderRadius: 12,
      border: "1px solid #a29bfe60",
      background: "transparent",
      color: "#a29bfe",
      fontSize: 10,
      cursor: monthAiBusy ? "wait" : "pointer",
      fontFamily: "inherit",
      opacity: monthAiBusy ? 0.6 : 1
    }
  }, monthAiBusy ? "分析中(15-20秒)..." : `🤖 分析${MONTHS[detailMonth]}`), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 4,
      flexWrap: "wrap"
    }
  }, MONTHS.map((_, mi) => /*#__PURE__*/React.createElement("button", {
    key: mi,
    onClick: () => setDetailMonth(mi),
    style: {
      padding: "2px 8px",
      borderRadius: 12,
      border: `1px solid ${detailMonth === mi ? "#74b9ff" : "var(--border2)"}`,
      background: detailMonth === mi ? "#74b9ff22" : "transparent",
      color: detailMonth === mi ? "#74b9ff" : "var(--text-dim)",
      fontSize: 10,
      cursor: "pointer"
    }
  }, mi + 1, "月")))), monthAiResult && /*#__PURE__*/React.createElement("div", {
    style: {
      margin: "0 0 10px",
      padding: 10,
      borderRadius: 10,
      border: `1px solid ${monthAiResult.error ? "#e94560" : "#a29bfe"}`,
      background: monthAiResult.error ? "rgba(233,69,96,0.08)" : "rgba(162,155,254,0.08)",
      fontSize: 12,
      whiteSpace: "pre-wrap",
      lineHeight: 1.5
    }
  }, monthAiResult.error ? `⚠️ ${monthAiResult.error}` : monthAiResult.text), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(7,1fr)",
      gap: 1
    }
  }, getDayStats(selMasterId, year, detailMonth).map(({
    d,
    total,
    newC,
    isVac
  }) => /*#__PURE__*/React.createElement("div", {
    key: d,
    style: {
      background: isVac ? "rgba(233,69,96,0.2)" : total > 0 ? "var(--bg-header)" : "var(--bg-sub)",
      borderRadius: 6,
      padding: "5px 3px",
      textAlign: "center",
      border: `1px solid ${isVac ? "#e9456040" : newC > 0 ? "#f5a62340" : "var(--border)"}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 9,
      color: "var(--text-dim)",
      marginBottom: 2
    }
  }, d, "日"), isVac ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "#e94560",
      fontWeight: 700
    }
  }, "休") : /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      fontWeight: 700,
      color: total > 0 ? "#74b9ff" : "var(--text-dim)"
    }
  }, total || "—"), newC > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: "#f5c842",
      fontWeight: 900,
      marginTop: 1
    }
  }, "★新", newC))))), debugInfo && /*#__PURE__*/React.createElement("div", {
    onClick: () => setDebugInfo(null),
    "data-modal-backdrop": "true",
    style: {
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,.7)",
      zIndex: 999,
      display: "flex",
      alignItems: "flex-end",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      background: "var(--bg-sub)",
      borderRadius: "16px 16px 0 0",
      padding: "20px 16px 30px",
      width: "100%",
      maxWidth: 560,
      maxHeight: "75vh",
      display: "flex",
      flexDirection: "column"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 36,
      height: 4,
      background: "var(--border)",
      borderRadius: 2,
      margin: "0 auto 14px"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 15,
      fontWeight: 900,
      marginBottom: 6
    }
  }, "🔍 ", debugInfo.y, "年", debugInfo.m + 1, "月 — 計入規則檢查"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "var(--text-muted)",
      marginBottom: 14,
      lineHeight: 1.7
    }
  }, /*#__PURE__*/React.createElement("div", null, "📊 該月所有預約紀錄：", /*#__PURE__*/React.createElement("b", {
    style: {
      color: "var(--text-main)"
    }
  }, debugInfo.all), " 筆"), /*#__PURE__*/React.createElement("div", null, "✓ 計入人數：", /*#__PURE__*/React.createElement("b", {
    style: {
      color: "#74b9ff"
    }
  }, debugInfo.counted), " 筆"), /*#__PURE__*/React.createElement("div", null, "✗ 未計入：", /*#__PURE__*/React.createElement("b", {
    style: {
      color: "#e94560"
    }
  }, debugInfo.excluded.length), " 筆（明細如下）")), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: "auto",
      border: "1px solid var(--border)",
      borderRadius: 8
    }
  }, debugInfo.excluded.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 20,
      textAlign: "center",
      color: "var(--text-dim)",
      fontSize: 13
    }
  }, "✅ 所有紀錄都已計入") : /*#__PURE__*/React.createElement("table", {
    style: {
      width: "100%",
      borderCollapse: "collapse",
      fontSize: 11
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    style: {
      background: "var(--bg-header)",
      position: "sticky",
      top: 0
    }
  }, /*#__PURE__*/React.createElement("th", {
    style: {
      padding: "6px 4px",
      textAlign: "left",
      borderBottom: "1px solid var(--border)"
    }
  }, "日期"), /*#__PURE__*/React.createElement("th", {
    style: {
      padding: "6px 4px",
      textAlign: "left",
      borderBottom: "1px solid var(--border)"
    }
  }, "名字"), /*#__PURE__*/React.createElement("th", {
    style: {
      padding: "6px 4px",
      textAlign: "center",
      borderBottom: "1px solid var(--border)"
    }
  }, "色標"), /*#__PURE__*/React.createElement("th", {
    style: {
      padding: "6px 4px",
      textAlign: "center",
      borderBottom: "1px solid var(--border)"
    }
  }, "人數"), /*#__PURE__*/React.createElement("th", {
    style: {
      padding: "6px 4px",
      textAlign: "left",
      borderBottom: "1px solid var(--border)"
    }
  }, "未計入原因"))), /*#__PURE__*/React.createElement("tbody", null, debugInfo.excluded.map((b, i) => {
    const colorLabel = {
      none: "舊客",
      new_customer: "新客",
      vacation: "休假",
      reserved: "卡位",
      custom: "自訂",
      aftercare: "售後"
    }[b.color_tag || "none"] || b.color_tag;
    let reason = "";
    if (!b.guest_count || b.guest_count <= 0) reason = "人數=0";else if (b.color_tag === "vacation") reason = "休假不計";else if (b.color_tag === "aftercare") reason = "售後不計";else if (b.color_tag === "reserved" || b.color_tag === "custom") {
      const nm = (b.customer_name || "").replace(/\s+/g, "").trim();
      if (nm === "") reason = "名字空白";else if (ALL_DEFAULT_NAMES.has(nm)) reason = `名字="${nm}"（預設值）`;
    }
    return /*#__PURE__*/React.createElement("tr", {
      key: i,
      style: {
        borderBottom: "1px solid var(--border)"
      }
    }, /*#__PURE__*/React.createElement("td", {
      style: {
        padding: "6px 4px",
        color: "var(--text-dim)",
        whiteSpace: "nowrap"
      }
    }, b.date.slice(5)), /*#__PURE__*/React.createElement("td", {
      style: {
        padding: "6px 4px",
        color: "var(--text-main)"
      }
    }, b.customer_name || "(空)"), /*#__PURE__*/React.createElement("td", {
      style: {
        padding: "6px 4px",
        textAlign: "center",
        color: "var(--text-muted)"
      }
    }, colorLabel), /*#__PURE__*/React.createElement("td", {
      style: {
        padding: "6px 4px",
        textAlign: "center"
      }
    }, b.guest_count), /*#__PURE__*/React.createElement("td", {
      style: {
        padding: "6px 4px",
        color: "#f5a623",
        fontSize: 10
      }
    }, reason));
  })))), /*#__PURE__*/React.createElement("button", {
    onClick: () => setDebugInfo(null),
    style: {
      marginTop: 12,
      padding: 10,
      borderRadius: 8,
      background: "var(--bg-header)",
      border: "1px solid var(--border)",
      color: "var(--text-main)",
      fontSize: 13,
      fontWeight: 700,
      cursor: "pointer"
    }
  }, "關閉"))))), anaTab === "summary" && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      marginBottom: 12,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setYear(y => y - 1),
    className: "nb"
  }, "◀"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 700,
      fontSize: 14
    }
  }, year, "年"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setYear(y => y + 1),
    className: "nb"
  }, "▶")), [["每月總客數表", "total", "#74b9ff"], ["每月新客總表", "newC", "#f5a623"], ["每月舊客總表", "old", "#00b894"]].map(([title, key, color]) => /*#__PURE__*/React.createElement("div", {
    key: key,
    style: {
      marginBottom: 16,
      overflowX: "auto"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      color,
      marginBottom: 6
    }
  }, title), /*#__PURE__*/React.createElement("table", {
    style: {
      borderCollapse: "collapse",
      width: "100%",
      minWidth: 500
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      ...TH,
      textAlign: "left",
      minWidth: 45
    }
  }, "月份"), activeMasters.map(m => /*#__PURE__*/React.createElement("th", {
    key: m.id,
    style: {
      ...TH,
      minWidth: 55
    }
  }, m.name)), /*#__PURE__*/React.createElement("th", {
    style: {
      ...TH,
      color,
      minWidth: 60
    }
  }, "綜合"))), /*#__PURE__*/React.createElement("tbody", null, MONTHS.map((ml, mi) => {
    const stats = activeMasters.map(m => calcStat(m.id, year, mi));
    const rowTotal = stats.reduce((s, st) => s + st[key], 0);
    return /*#__PURE__*/React.createElement("tr", {
      key: mi,
      style: {
        background: mi % 2 === 0 ? "var(--bg-main)" : "var(--bg-sub)"
      }
    }, /*#__PURE__*/React.createElement("td", {
      style: {
        ...TC,
        textAlign: "left",
        fontWeight: 600,
        color: "var(--text-muted)"
      }
    }, ml), stats.map((s, si) => /*#__PURE__*/React.createElement("td", {
      key: si,
      style: {
        ...TC,
        color: s[key] > 0 ? color : "var(--text-dim)",
        fontWeight: s[key] > 0 ? 700 : 400
      }
    }, s[key] || "—")), /*#__PURE__*/React.createElement("td", {
      style: {
        ...TC,
        fontWeight: 800,
        color,
        background: "var(--bg-week)"
      }
    }, rowTotal || "—"));
  }), /*#__PURE__*/React.createElement("tr", {
    style: {
      background: "var(--bg-week)"
    }
  }, /*#__PURE__*/React.createElement("td", {
    style: {
      ...TC,
      fontWeight: 800,
      textAlign: "left",
      color: "var(--text-muted)"
    }
  }, "合計"), activeMasters.map(m => {
    const ys = calcYearStat(m.id, year);
    return /*#__PURE__*/React.createElement("td", {
      key: m.id,
      style: {
        ...TC,
        fontWeight: 800,
        color,
        fontSize: 12
      }
    }, ys[key] || "—");
  }), /*#__PURE__*/React.createElement("td", {
    style: {
      ...TC,
      fontWeight: 800,
      color,
      fontSize: 13
    }
  }, activeMasters.reduce((s, m) => s + calcYearStat(m.id, year)[key], 0) || "—"))))))), anaTab === "yearly" && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      marginBottom: 12,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "var(--text-muted)"
    }
  }, "對比年份："), /*#__PURE__*/React.createElement("select", {
    value: yearA,
    onChange: e => setYearA(Number(e.target.value)),
    style: {
      background: "var(--nav-bg)",
      border: "1px solid var(--border2)",
      borderRadius: 5,
      padding: "3px 8px",
      fontSize: 12,
      color: "var(--text-main)"
    }
  }, DYNAMIC_YEARS.map(y => /*#__PURE__*/React.createElement("option", {
    key: y,
    value: y
  }, y))), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-dim)"
    }
  }, "vs"), /*#__PURE__*/React.createElement("select", {
    value: yearB,
    onChange: e => setYearB(Number(e.target.value)),
    style: {
      background: "var(--nav-bg)",
      border: "1px solid var(--border2)",
      borderRadius: 5,
      padding: "3px 8px",
      fontSize: 12,
      color: "var(--text-main)"
    }
  }, DYNAMIC_YEARS.map(y => /*#__PURE__*/React.createElement("option", {
    key: y,
    value: y
  }, y)))), activeMasters.map(m => {
    const statsA = Array.from({
      length: 12
    }, (_, mi) => calcStat(m.id, yearA, mi));
    const statsB = Array.from({
      length: 12
    }, (_, mi) => calcStat(m.id, yearB, mi));
    const totA = statsA.reduce((s, x) => s + x.total, 0),
      totB = statsB.reduce((s, x) => s + x.total, 0),
      diff = totB - totA;
    return /*#__PURE__*/React.createElement("div", {
      key: m.id,
      style: {
        marginBottom: 16,
        background: "var(--bg-header)",
        borderRadius: 10,
        border: "1px solid var(--border2)",
        overflow: "hidden"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        padding: "8px 14px",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontWeight: 700,
        fontSize: 13
      }
    }, m.name), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 12
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        color: "#74b9ff"
      }
    }, yearA, ":", totA), /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--text-dim)",
        margin: "0 6px"
      }
    }, "→"), /*#__PURE__*/React.createElement("span", {
      style: {
        color: "#f5a623"
      }
    }, yearB, ":", totB), /*#__PURE__*/React.createElement("span", {
      style: {
        marginLeft: 8,
        color: diff >= 0 ? "#00b894" : "#e94560",
        fontWeight: 700
      }
    }, diff >= 0 ? "+" : "", diff))), /*#__PURE__*/React.createElement("div", {
      style: {
        overflowX: "auto"
      }
    }, /*#__PURE__*/React.createElement("table", {
      style: {
        borderCollapse: "collapse",
        width: "100%",
        minWidth: 500
      }
    }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
      style: {
        ...TH,
        textAlign: "left",
        minWidth: 55
      }
    }, "月份"), MONTHS.map((ml, mi) => /*#__PURE__*/React.createElement("th", {
      key: mi,
      style: {
        ...TH,
        minWidth: 42
      }
    }, mi + 1, "月")), /*#__PURE__*/React.createElement("th", {
      style: {
        ...TH,
        minWidth: 50
      }
    }, "全年"))), /*#__PURE__*/React.createElement("tbody", null, [[yearA, "#74b9ff"], [yearB, "#f5a623"]].map(([y, color]) => {
      const stats = Array.from({
        length: 12
      }, (_, mi) => calcStat(m.id, y, mi));
      const yTotal = stats.reduce((s, x) => s + x.total, 0);
      return /*#__PURE__*/React.createElement("tr", {
        key: y
      }, /*#__PURE__*/React.createElement("td", {
        style: {
          ...TC,
          fontWeight: 700,
          color,
          textAlign: "left"
        }
      }, y, "年"), stats.map((s, mi) => /*#__PURE__*/React.createElement("td", {
        key: mi,
        style: {
          ...TC,
          color: s.total > 0 ? color : "var(--text-dim)",
          fontWeight: s.total > 0 ? 600 : 400
        }
      }, s.total || "—")), /*#__PURE__*/React.createElement("td", {
        style: {
          ...TC,
          fontWeight: 800,
          color,
          background: "var(--bg-week)"
        }
      }, yTotal || "—"));
    }), /*#__PURE__*/React.createElement("tr", {
      style: {
        background: "var(--bg-sub)"
      }
    }, /*#__PURE__*/React.createElement("td", {
      style: {
        ...TC,
        fontWeight: 700,
        color: "var(--text-dim)",
        textAlign: "left",
        fontSize: 10
      }
    }, "增減"), Array.from({
      length: 12
    }, (_, mi) => {
      const d = statsB[mi].total - statsA[mi].total;
      return /*#__PURE__*/React.createElement("td", {
        key: mi,
        style: {
          ...TC,
          color: d > 0 ? "#00b894" : d < 0 ? "#e94560" : "var(--text-dim)",
          fontWeight: d !== 0 ? 700 : 400,
          fontSize: 10
        }
      }, d > 0 ? "+" : "", d || "—");
    }), /*#__PURE__*/React.createElement("td", {
      style: {
        ...TC,
        fontWeight: 800,
        color: diff >= 0 ? "#00b894" : "#e94560",
        background: "var(--bg-week)"
      }
    }, diff >= 0 ? "+" : "", diff)), [[yearA, "#74b9ff"], [yearB, "#f5a623"]].map(([y, color]) => {
      const stats = Array.from({
        length: 12
      }, (_, mi) => calcStat(m.id, y, mi));
      const yNew = stats.reduce((s, x) => s + x.newC, 0);
      return /*#__PURE__*/React.createElement("tr", {
        key: `new${y}`,
        style: {
          opacity: 0.8
        }
      }, /*#__PURE__*/React.createElement("td", {
        style: {
          ...TC,
          fontSize: 9,
          color: "#f5a623",
          textAlign: "left"
        }
      }, y, "新客"), stats.map((s, mi) => /*#__PURE__*/React.createElement("td", {
        key: mi,
        style: {
          ...TC,
          fontSize: 9,
          color: s.newC > 0 ? "#f5a623" : "var(--text-dim)"
        }
      }, s.newC || "—")), /*#__PURE__*/React.createElement("td", {
        style: {
          ...TC,
          fontSize: 10,
          fontWeight: 700,
          color: "#f5a623",
          background: "var(--bg-week)"
        }
      }, yNew || "—"));
    })))));
  })));
}

;
