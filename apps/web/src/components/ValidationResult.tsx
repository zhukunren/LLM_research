import { AlertCircle, AlertTriangle, Info } from "lucide-react";

interface ValidationResultProps {
  validation: {
    errors: string[];
    warnings: string[];
    suggestions: string[];
  };
}

export function ValidationResult({ validation }: ValidationResultProps) {
  const hasErrors = validation.errors.length > 0;
  const hasWarnings = validation.warnings.length > 0;
  const hasSuggestions = validation.suggestions.length > 0;

  if (!hasErrors && !hasWarnings && !hasSuggestions) {
    return null;
  }

  return (
    <div
      style={{
        marginTop: "16px",
        padding: "16px",
        borderRadius: "var(--radius-card)",
        border: `1px solid ${hasErrors ? "#fcc" : hasWarnings ? "#fed" : "#e3e8ef"}`,
        backgroundColor: hasErrors ? "#fef5f5" : hasWarnings ? "#fffbf0" : "#f8f9fb",
      }}
    >
      <h4
        style={{
          margin: "0 0 12px",
          fontSize: "14px",
          fontWeight: 600,
          color: hasErrors ? "#c33" : hasWarnings ? "#e67700" : "var(--ui-text)",
          display: "flex",
          alignItems: "center",
          gap: "8px",
        }}
      >
        {hasErrors ? (
          <>
            <AlertCircle size={16} />
            验证未通过
          </>
        ) : hasWarnings ? (
          <>
            <AlertTriangle size={16} />
            验证通过，有提示
          </>
        ) : (
          <>
            <Info size={16} />
            验证建议
          </>
        )}
      </h4>

      {hasErrors && (
        <div style={{ marginBottom: hasSuggestions || hasWarnings ? "12px" : 0 }}>
          <div
            style={{
              fontSize: "13px",
              fontWeight: 600,
              marginBottom: "6px",
              color: "#c33",
            }}
          >
            错误（阻止提交）：
          </div>
          <ul
            style={{
              margin: 0,
              paddingLeft: "20px",
              fontSize: "13px",
              lineHeight: "1.6",
              color: "#c33",
            }}
          >
            {validation.errors.map((error, index) => (
              <li key={index}>{error}</li>
            ))}
          </ul>
        </div>
      )}

      {hasWarnings && (
        <div style={{ marginBottom: hasSuggestions ? "12px" : 0 }}>
          <div
            style={{
              fontSize: "13px",
              fontWeight: 600,
              marginBottom: "6px",
              color: "#e67700",
            }}
          >
            警告（建议修改）：
          </div>
          <ul
            style={{
              margin: 0,
              paddingLeft: "20px",
              fontSize: "13px",
              lineHeight: "1.6",
              color: "#996600",
            }}
          >
            {validation.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      {hasSuggestions && (
        <div>
          <div
            style={{
              fontSize: "13px",
              fontWeight: 600,
              marginBottom: "6px",
              color: "var(--ui-text-soft)",
            }}
          >
            建议：
          </div>
          <ul
            style={{
              margin: 0,
              paddingLeft: "20px",
              fontSize: "13px",
              lineHeight: "1.6",
              color: "var(--ui-text-soft)",
            }}
          >
            {validation.suggestions.map((suggestion, index) => (
              <li key={index}>{suggestion}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
