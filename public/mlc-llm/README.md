# Bundled MLC Assets

If you want `MLC-LLM` to work fully offline on first launch, place bundled model assets here.

- Model directory: `public/mlc-llm/models/<model-id>/`
- Wasm library: `public/mlc-llm/libs/<wasm-file>`

The app will prefer these local assets when both `mlc-chat-config.json` and the matching wasm file exist.
