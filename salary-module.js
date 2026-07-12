// ═══════════════════════════════════════════
// SALARY MODULE — 薪資結算（只有 admin/editor 進得來，見index.html的💰按鈕）
// ═══════════════════════════════════════════
// 結算週期：週結算 = 週日～週六(7天)；月結算 = 該月1號～月底(完整月，
// 不特別cap到今天——這是純數字表格，還沒發生的天數自然就是0，不會誤導人，
// 跟AI分析那邊會刻意cap到今天不一樣，那邊是怕AI對著未來的0亂解讀)。
// 麒(老闆/admin)不算在抽成邏輯裡，後端compute_commission_settlement已經
// 排除，這裡不用再擋一次。
(function () {
  const DOW = ["日", "一", "二", "三", "四", "五", "六"];

  function pad2(n) { return String(n).padStart(2, "0"); }
  function toStr(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

  // 傳入任一天，回傳「那一天所在週」的週日跟週六
  function getWeekRange(anyDate) {
    const sunday = new Date(anyDate);
    sunday.setDate(sunday.getDate() - sunday.getDay());
    const saturday = new Date(sunday);
    saturday.setDate(saturday.getDate() + 6);
    return { start: sunday, end: saturday };
  }

  function getMonthRange(year, month) {
    const start = new Date(year, month, 1);
    const end = new Date(year, month + 1, 0);
    return { start, end };
  }

  function fmtLabel(d) {
    return `${d.getMonth() + 1}/${d.getDate()}(${DOW[d.getDay()]})`;
  }

  window.SalaryModule = function SalaryModule({ onClose, masters, currentMaster }) {
    const [subView, setSubView] = React.useState("report"); // 'report' | 'settings'
    const [periodType, setPeriodType] = React.useState("week"); // 'week' | 'month'
    const [refDate, setRefDate] = React.useState(() => getTaipeiNow());
    const [settlement, setSettlement] = React.useState(null);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState("");

    const { start, end } = periodType === "week"
      ? getWeekRange(refDate)
      : getMonthRange(refDate.getFullYear(), refDate.getMonth());
    const startStr = toStr(start);
    const endStr = toStr(end);

    React.useEffect(() => {
      let cancelled = false;
      setLoading(true);
      setError("");
      sb.rpc("compute_commission_settlement", { p_start: startStr, p_end: endStr }).then(({ data, error: err }) => {
        if (cancelled) return;
        if (err) { setError(err.message); setSettlement(null); }
        else { setSettlement(data); }
        setLoading(false);
      });
      return () => { cancelled = true; };
    }, [periodType, startStr, endStr]);

    const shiftPeriod = (dir) => {
      const d = new Date(refDate);
      if (periodType === "week") d.setDate(d.getDate() + dir * 7);
      else d.setMonth(d.getMonth() + dir);
      setRefDate(d);
    };

    const periodLabel = periodType === "week"
      ? `${fmtLabel(start)} ～ ${fmtLabel(end)}`
      : `${start.getFullYear()}年${start.getMonth() + 1}月`;

    return React.createElement("div", {
      "data-modal-backdrop": "true",
      style: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 12 },
      onClick: onClose
    },
      React.createElement("div", {
        style: { background: "var(--bg-header)", borderRadius: 16, width: "100%", maxWidth: 480, maxHeight: "90vh", overflowY: "auto", padding: 16 },
        onClick: (e) => e.stopPropagation()
      },
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 } },
          React.createElement("div", { style: { fontWeight: 900, fontSize: 16 } }, "💰 薪資結算"),
          React.createElement("button", {
            onClick: onClose,
            style: { background: "none", border: "none", color: "var(--text-dim)", fontSize: 20, cursor: "pointer", padding: 4 }
          }, "✕")
        ),
        React.createElement("div", { style: { display: "flex", gap: 6, marginBottom: 14 } },
          React.createElement("button", {
            onClick: () => setSubView("report"),
            style: tabBtnStyle(subView === "report")
          }, "報表"),
          React.createElement("button", {
            onClick: () => setSubView("settings"),
            style: tabBtnStyle(subView === "settings")
          }, "⚙️ 設定趴數")
        ),
        subView === "report"
          ? React.createElement(ReportView, { periodType, setPeriodType, periodLabel, shiftPeriod, settlement, loading, error })
          : React.createElement(SettingsView, { masters, currentMaster })
      )
    );
  };

  function tabBtnStyle(active) {
    return {
      flex: 1, padding: "8px 4px", borderRadius: 10,
      border: `1px solid ${active ? "#a29bfe" : "var(--border2)"}`,
      background: active ? "#a29bfe22" : "transparent",
      color: active ? "#a29bfe" : "var(--text-dim)",
      fontWeight: 700, fontSize: 13, cursor: "pointer"
    };
  }

  function ReportView({ periodType, setPeriodType, periodLabel, shiftPeriod, settlement, loading, error }) {
    return React.createElement(React.Fragment, null,
      React.createElement("div", { style: { display: "flex", gap: 6, marginBottom: 10 } },
        React.createElement("button", {
          onClick: () => setPeriodType("week"),
          style: { ...tabBtnStyle(periodType === "week"), flex: "none", padding: "5px 12px", fontSize: 12 }
        }, "週結算"),
        React.createElement("button", {
          onClick: () => setPeriodType("month"),
          style: { ...tabBtnStyle(periodType === "month"), flex: "none", padding: "5px 12px", fontSize: 12 }
        }, "月結算")
      ),
      React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 } },
        React.createElement("button", { onClick: () => shiftPeriod(-1), className: "nb" }, "◀"),
        React.createElement("div", { style: { fontWeight: 700, fontSize: 13 } }, periodLabel),
        React.createElement("button", { onClick: () => shiftPeriod(1), className: "nb" }, "▶")
      ),
      loading && React.createElement("div", { style: { textAlign: "center", padding: 20, color: "var(--text-dim)" } }, "計算中…"),
      error && React.createElement("div", { style: { color: "#e94560", fontSize: 12, padding: 10 } }, "⚠️ " + error),
      !loading && !error && settlement && React.createElement("div", null,
        (settlement.by_master || []).map((m) => React.createElement("div", {
          key: m.master_id,
          style: { border: "1px solid var(--border)", borderRadius: 10, padding: 12, marginBottom: 10 }
        },
          React.createElement("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: 6 } },
            React.createElement("div", { style: { fontWeight: 900, fontSize: 14 } }, m.master_name),
            React.createElement("div", { style: { fontWeight: 900, fontSize: 15, color: "#00b894" } }, `NT$ ${m.total_pay.toLocaleString()}`)
          ),
          React.createElement("div", { style: { fontSize: 11, color: "var(--text-dim)", lineHeight: 1.8 } },
            `人數 ${m.count}　營收 NT$${m.revenue.toLocaleString()}　自己抽成 ${m.own_rate}% = NT$${m.own_commission.toLocaleString()}`
          ),
          m.cross_commission_detail && m.cross_commission_detail.length > 0 && React.createElement("div", { style: { fontSize: 11, color: "#a29bfe", marginTop: 4 } },
            m.cross_commission_detail.map((c, i) => React.createElement("div", { key: i },
              `+ ${c.source_master_name} 營收的 ${c.rate}% = NT$${c.amount.toLocaleString()}`
            ))
          )
        )),
        (!settlement.by_master || settlement.by_master.length === 0) && React.createElement("div", { style: { textAlign: "center", padding: 20, color: "var(--text-dim)", fontSize: 12 } }, "這段期間沒有資料")
      )
    );
  }

  function SettingsView({ masters, currentMaster }) {
    const nonAdminMasters = (masters || []).filter((m) => m.role !== "admin" && m.role !== "editor");
    const [rates, setRates] = React.useState({});
    const [overrides, setOverrides] = React.useState([]);
    const [loading, setLoading] = React.useState(true);
    const [savingId, setSavingId] = React.useState(null);
    const [newOverride, setNewOverride] = React.useState({ beneficiary: "", source: "", rate: "" });
    const [msg, setMsg] = React.useState("");

    const load = () => {
      setLoading(true);
      Promise.all([
        sb.from("commission_rates").select("*"),
        sb.from("commission_overrides").select("*")
      ]).then(([r1, r2]) => {
        const rateMap = {};
        (r1.data || []).forEach((r) => { rateMap[r.master_id] = r.rate; });
        setRates(rateMap);
        setOverrides(r2.data || []);
        setLoading(false);
      });
    };
    React.useEffect(load, []);

    const nameOf = (id) => (masters.find((m) => m.id === id) || {}).name || "?";

    const saveRate = async (masterId, value) => {
      const rate = parseFloat(value);
      if (isNaN(rate) || rate < 0 || rate > 100) { setMsg("⚠️ 趴數要在0-100之間"); return; }
      setSavingId(masterId);
      const { error } = await sb.from("commission_rates").upsert({ master_id: masterId, rate, updated_by: currentMaster?.id, updated_at: new Date().toISOString() });
      setSavingId(null);
      if (error) setMsg("⚠️ 存檔失敗：" + error.message);
      else { setMsg("✓ 已儲存"); setTimeout(() => setMsg(""), 2000); load(); }
    };

    const addOverride = async () => {
      if (!newOverride.beneficiary || !newOverride.source || newOverride.beneficiary === newOverride.source) {
        setMsg("⚠️ 請選擇兩位不同的師傅"); return;
      }
      const rate = parseFloat(newOverride.rate);
      if (isNaN(rate) || rate < 0 || rate > 100) { setMsg("⚠️ 趴數要在0-100之間"); return; }
      const { error } = await sb.from("commission_overrides").upsert({
        beneficiary_master_id: newOverride.beneficiary,
        source_master_id: newOverride.source,
        rate,
        updated_by: currentMaster?.id,
        updated_at: new Date().toISOString()
      }, { onConflict: "beneficiary_master_id,source_master_id" });
      if (error) setMsg("⚠️ 新增失敗：" + error.message);
      else { setNewOverride({ beneficiary: "", source: "", rate: "" }); setMsg("✓ 已新增"); setTimeout(() => setMsg(""), 2000); load(); }
    };

    const deleteOverride = async (id) => {
      const { error } = await sb.from("commission_overrides").delete().eq("id", id);
      if (error) setMsg("⚠️ 刪除失敗：" + error.message);
      else load();
    };

    if (loading) return React.createElement("div", { style: { textAlign: "center", padding: 20, color: "var(--text-dim)" } }, "載入中…");

    return React.createElement("div", null,
      msg && React.createElement("div", { style: { fontSize: 12, color: msg.startsWith("✓") ? "#00b894" : "#e94560", marginBottom: 10, fontWeight: 700 } }, msg),
      React.createElement("div", { style: { fontSize: 12, fontWeight: 700, marginBottom: 8, color: "var(--text-muted)" } }, "各自的基本趴數"),
      nonAdminMasters.map((m) => React.createElement("div", {
        key: m.id,
        style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }
      },
        React.createElement("div", { style: { width: 50, fontSize: 13, fontWeight: 700 } }, m.name),
        React.createElement("input", {
          type: "number", min: 0, max: 100, step: 0.5,
          defaultValue: rates[m.id] ?? 0,
          onBlur: (e) => saveRate(m.id, e.target.value),
          disabled: savingId === m.id,
          style: { width: 70, padding: "4px 6px", borderRadius: 6, border: "1px solid var(--border2)", background: "var(--bg-main)", color: "var(--text-main)", fontSize: 13 }
        }),
        React.createElement("span", { style: { fontSize: 12, color: "var(--text-dim)" } }, "%", savingId === m.id ? "　儲存中…" : "")
      )),
      React.createElement("div", { style: { fontSize: 12, fontWeight: 700, marginTop: 16, marginBottom: 8, color: "var(--text-muted)" } }, "額外抽成（誰拿誰的營收幾%）"),
      overrides.length === 0 && React.createElement("div", { style: { fontSize: 11, color: "var(--text-dim)", marginBottom: 8 } }, "目前沒有設定"),
      overrides.map((o) => React.createElement("div", {
        key: o.id,
        style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 6, fontSize: 12 }
      },
        React.createElement("div", { style: { flex: 1 } }, `${nameOf(o.beneficiary_master_id)} 拿 ${nameOf(o.source_master_id)} 的 ${o.rate}%`),
        React.createElement("button", {
          onClick: () => deleteOverride(o.id),
          style: { background: "none", border: "1px solid #e9456060", color: "#e94560", borderRadius: 6, fontSize: 11, padding: "2px 8px", cursor: "pointer" }
        }, "刪除")
      )),
      React.createElement("div", { style: { display: "flex", gap: 6, marginTop: 10, alignItems: "center", flexWrap: "wrap" } },
        React.createElement("select", {
          value: newOverride.beneficiary,
          onChange: (e) => setNewOverride({ ...newOverride, beneficiary: e.target.value }),
          style: selectStyle
        }, React.createElement("option", { value: "" }, "誰拿"), nonAdminMasters.map((m) => React.createElement("option", { key: m.id, value: m.id }, m.name))),
        React.createElement("span", { style: { fontSize: 11, color: "var(--text-dim)" } }, "拿"),
        React.createElement("select", {
          value: newOverride.source,
          onChange: (e) => setNewOverride({ ...newOverride, source: e.target.value }),
          style: selectStyle
        }, React.createElement("option", { value: "" }, "誰的"), nonAdminMasters.map((m) => React.createElement("option", { key: m.id, value: m.id }, m.name))),
        React.createElement("input", {
          type: "number", min: 0, max: 100, step: 0.5, placeholder: "%",
          value: newOverride.rate,
          onChange: (e) => setNewOverride({ ...newOverride, rate: e.target.value }),
          style: { width: 50, padding: "4px 6px", borderRadius: 6, border: "1px solid var(--border2)", background: "var(--bg-main)", color: "var(--text-main)", fontSize: 12 }
        }),
        React.createElement("button", {
          onClick: addOverride,
          style: { padding: "4px 10px", borderRadius: 6, border: "1px solid #00b894", background: "#00b89422", color: "#00b894", fontSize: 12, cursor: "pointer" }
        }, "新增")
      )
    );
  }

  const selectStyle = { padding: "4px 6px", borderRadius: 6, border: "1px solid var(--border2)", background: "var(--bg-main)", color: "var(--text-main)", fontSize: 12 };
})();
