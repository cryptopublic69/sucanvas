import type { ExternalProvidersController } from "./types";

export function ExternalProviderSettingsSection({
  providers,
}: {
  providers: ExternalProvidersController;
}) {
  if (!providers.enabled) return null;
  return (
    <section
      className="general-settings-group external-providers-settings-group"
      aria-labelledby="external-providers-settings-title"
    >
      <div className="general-settings-group-heading external-providers-settings-header">
        <div>
          <h4 id="external-providers-settings-title">外部 AI 平台 CLI（Seedance 2.0 / 2.5 视频）</h4>
          <p>由画布服务器本机托管 CLI 与授权状态，所有网页登录用户可直接调用视频生成。</p>
        </div>
        <button
          type="button"
          className="external-providers-refresh-btn"
          disabled={providers.loading}
          onClick={() => void providers.refresh()}
        >
          {providers.loading ? "检测中…" : "刷新平台状态"}
        </button>
      </div>
      {providers.error && <p role="alert">{providers.error}</p>}
      <div className="external-providers-status-grid">
        {providers.providers.map((item) => (
          <article
            key={item.provider}
            className={`external-provider-card ${item.ready ? "is-ready" : "is-warn"}`}
          >
            <header>
              <strong>{item.label}</strong>
              <span>{item.statusText}</span>
            </header>
            <small>
              支持模型：{item.models.length} 个（Seedance 2.5 / 2.0）
            </small>
            {item.error && <p className="external-provider-card-error">{item.error}</p>}
          </article>
        ))}
      </div>
    </section>
  );
}
