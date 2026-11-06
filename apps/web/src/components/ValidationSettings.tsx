import { useEffect, useState } from "react";
import { api } from "../api";

interface ValidationLevel {
  value: string;
  label: string;
  description: string;
}

interface ValidationSettingsData {
  level: string;
  description: string;
  available_levels: ValidationLevel[];
}

export function AdvisorValidationSettings() {
  const [settings, setSettings] = useState<ValidationSettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    try {
      const data = await api<ValidationSettingsData>("/settings/advisor-validation");
      setSettings(data);
    } catch (error) {
      console.error("Failed to load validation settings:", error);
    }
  }

  async function handleLevelChange(newLevel: string) {
    setSaving(true);
    setMessage(null);
    try {
      await api("/settings/advisor-validation", {
        method: "POST",
        body: JSON.stringify({ level: newLevel }),
      });
      setMessage({ type: "success", text: "设置已保存" });
      await loadSettings();
    } catch (error) {
      setMessage({ type: "error", text: "保存失败，请重试" });
      console.error("Failed to save validation settings:", error);
    } finally {
      setSaving(false);
      setTimeout(() => setMessage(null), 3000);
    }
  }

  if (!settings) {
    return <div style={{ padding: "16px", color: "var(--ui-text-soft)" }}>加载中...</div>;
  }

  return (
    <div style={{ padding: "20px", maxWidth: "600px" }}>
      <h3 style={{ margin: "0 0 8px", fontSize: "16px", fontWeight: 600, color: "var(--ui-text)" }}>
        投顾任务验证级别
      </h3>
      <p style={{ margin: "0 0 20px", fontSize: "14px", lineHeight: "1.6", color: "var(--ui-text-soft)" }}>
        两种级别都会拦截股票、日期、引用、金额和已确认事件时间错误。表达建议不阻止提交，交付前仍需投顾核对。
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {settings.available_levels.map((level) => (
          <label
            key={level.value}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "12px",
              padding: "14px",
              border: `2px solid ${settings.level === level.value ? "var(--ui-primary)" : "var(--ui-border)"}`,
              borderRadius: "var(--radius-card)",
              backgroundColor: settings.level === level.value ? "var(--ui-primary-soft)" : "white",
              cursor: "pointer",
              transition: "all 0.2s ease",
            }}
            onMouseEnter={(e) => {
              if (settings.level !== level.value) {
                e.currentTarget.style.borderColor = "var(--ui-border-hover)";
                e.currentTarget.style.backgroundColor = "var(--ui-surface)";
              }
            }}
            onMouseLeave={(e) => {
              if (settings.level !== level.value) {
                e.currentTarget.style.borderColor = "var(--ui-border)";
                e.currentTarget.style.backgroundColor = "white";
              }
            }}
          >
            <input
              type="radio"
              name="validation-level"
              value={level.value}
              checked={settings.level === level.value}
              onChange={(e) => handleLevelChange(e.target.value)}
              disabled={saving}
              style={{ marginTop: "3px", accentColor: "var(--ui-primary)" }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "4px", color: "var(--ui-text)" }}>
                {level.label}
              </div>
              <div style={{ fontSize: "13px", lineHeight: "1.5", color: "var(--ui-text-soft)" }}>
                {level.description}
              </div>
            </div>
          </label>
        ))}
      </div>

      {message && (
        <div
          style={{
            marginTop: "16px",
            padding: "12px 16px",
            borderRadius: "var(--radius-base)",
            fontSize: "14px",
            backgroundColor: message.type === "success" ? "#e6f0fa" : "#fee",
            color: message.type === "success" ? "#004a99" : "#c33",
            border: `1px solid ${message.type === "success" ? "#b3d7f5" : "#fcc"}`,
          }}
        >
          {message.text}
        </div>
      )}

      <div
        style={{
          marginTop: "20px",
          padding: "14px",
          borderRadius: "var(--radius-base)",
          fontSize: "13px",
          lineHeight: "1.6",
          backgroundColor: "var(--ui-surface)",
          color: "var(--ui-text-soft)",
          border: "1px solid var(--ui-border)",
        }}
      >
        <strong style={{ color: "var(--ui-text)" }}>说明：</strong>
        <ul style={{ margin: "8px 0 0", paddingLeft: "20px" }}>
          <li>基础级别：保留事实和证据校验，缺少客户稿口径或时间标注时给出核验提示</li>
          <li>严格级别：额外要求分析维度、客户稿口径与时间标注完整；术语、篇幅、段落仍只提示</li>
          <li>设置立即生效，影响所有新提交的投顾任务</li>
        </ul>
      </div>
    </div>
  );
}
