#!/bin/sh
# Installa whisper.cpp con encoder CoreML (Neural Engine) e il modello large-v3-turbo in ~/.cache.
# Niente Homebrew: su macOS 14 la formula whisper-cpp compila da sorgente llvm, rust e node (ore).
# Encoder su GPU Metal: ~3,5 s a frase; su Neural Engine: ~0,8 s.
set -eu
TOOLS="$HOME/.cache/qw-tools"
MODELS="$HOME/.cache/qw-models"
VERSION=v1.9.5
HF=https://huggingface.co/ggerganov/whisper.cpp/resolve/main
mkdir -p "$TOOLS" "$MODELS"

# cmake da wheel pip in un venv privato
[ -x "$TOOLS/venv/bin/cmake" ] || { python3 -m venv "$TOOLS/venv" && "$TOOLS/venv/bin/pip" install -q cmake; }
export PATH="$TOOLS/venv/bin:$PATH"

[ -d "$TOOLS/whisper.cpp" ] || git clone -q --depth 1 --branch "$VERSION" https://github.com/ggml-org/whisper.cpp.git "$TOOLS/whisper.cpp"
cd "$TOOLS/whisper.cpp"
cmake -B build-coreml -DCMAKE_BUILD_TYPE=Release -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON \
  -DWHISPER_COREML=1 -DWHISPER_BUILD_TESTS=OFF -DBUILD_SHARED_LIBS=OFF >/dev/null
cmake --build build-coreml -j 8 --target whisper-server whisper-cli >/dev/null

cd "$MODELS"
[ -f ggml-large-v3-turbo.bin ] || curl -fL --retry 3 -o ggml-large-v3-turbo.bin "$HF/ggml-large-v3-turbo.bin"
if [ ! -d ggml-large-v3-turbo-encoder.mlmodelc ]; then
  curl -fL --retry 3 -o enc.zip "$HF/ggml-large-v3-turbo-encoder.mlmodelc.zip"
  unzip -q enc.zip -x '__MACOSX/*' && rm enc.zip
fi
echo "whisper pronto: $TOOLS/whisper.cpp/build-coreml/bin/whisper-server"
echo "(il primo avvio compila l'encoder per il Neural Engine: ~1-2 minuti, poi resta in cache)"
