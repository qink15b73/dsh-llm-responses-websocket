window.__ModuleLoader__.load({
  id: "dsh-llm-responses-websocket",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const SETTINGS_NAMESPACE = "llm-pi-ai";
    const RESPONSES_PROTOCOLS = new Set([
      "openai-responses",
      "openai-codex-responses",
    ]);

    function WebSocketToggle({ provider, useSettingsForm }) {
      const { useSnapshot, mutate } = useSettingsForm;
      const snapshot = useSnapshot();
      const namespace = snapshot.value;
      const profile = namespace?.providers?.[provider.provider];
      const state = {
        status: snapshot.status,
        revision: snapshot.revision,
        writable: snapshot.writable,
        enabled: profile?.transport === "websocket",
        error: snapshot.error,
      };
      if (!profile || !RESPONSES_PROTOCOLS.has(profile.api)) return null;
      if (state.status === "loading" || state.status === "idle") return null;
      if (state.status === "error") {
        return h(
          "p",
          {
            role: "alert",
            style: {
              color: "var(--dsw-alias-status-danger, #c42b1c)",
              margin: "8px 0 0",
              fontSize: 12,
            },
          },
          `WebSocket setting unavailable: ${state.error ?? "settings are unavailable"}`,
        );
      }
      const onChange = async (event) => {
        const enabled = event.target.checked;
        try {
          await mutate(
            [
              {
                op: "set",
                path: ["providers", provider.provider, "transport"],
                value: enabled ? "websocket" : "auto",
              },
            ],
            state.revision,
          );
        } catch {
          // The shared settings form keeps the previous persisted snapshot and
          // exposes the write failure on its next render.
        }
      };
      return h(
        "label",
        {
          style: {
            display: "flex",
            gap: 8,
            alignItems: "center",
            margin: "10px 0 0",
            fontSize: 13,
            cursor: state.writable ? "pointer" : "default",
          },
        },
        [
          h("input", {
            key: "input",
            type: "checkbox",
            checked: state.enabled,
            disabled: !state.writable || state.status !== "ready",
            onChange,
          }),
          h("span", { key: "copy" }, "Use compatible Responses WebSocket"),
        ],
      );
    }

    return {
      inject: ["slots", "configForms"],
      apply(ctx) {
        ctx.slots.inject("settings.models.provider-card", () =>
          ctx.slots.register(
            {
              name: "settings.models.provider-card",
              key: SETTINGS_NAMESPACE,
              inject: () => {
                const form = ctx.configForms.get(SETTINGS_NAMESPACE);
                return {
                  useSettingsForm: {
                    useSnapshot: () =>
                      React.useSyncExternalStore(
                        form.subscribe.bind(form),
                        form.getSnapshot.bind(form),
                        form.getSnapshot.bind(form),
                      ),
                    mutate: form.mutate.bind(form),
                  },
                };
              },
            },
            WebSocketToggle,
          ),
        );
      },
    };
  },
});
