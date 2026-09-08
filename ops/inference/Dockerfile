# syntax=docker/dockerfile:1.7
FROM nvidia/cuda:12.8.1-devel-ubuntu24.04@sha256:520292dbb4f755fd360766059e62956e9379485d9e073bbd2f6e3c20c270ed66 AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake curl ca-certificates libssl-dev python3 python3-venv && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl --fail --location --retry 2 --max-time 600 https://api.github.com/repos/ggml-org/llama.cpp/tarball/5266f24da75dc449bd56cbed7addb9c8e4a6a73e -o /tmp/source.tar.gz \
    && echo '03960e7502cd81a74fe926c4d73c814306f4c264347a0944a0490bb036e6ec9e  /tmp/source.tar.gz' | sha256sum --check - \
    && tar -xzf /tmp/source.tar.gz --strip-components=1 && rm /tmp/source.tar.gz
RUN --mount=type=cache,id=browserskills-llama-5266f24-cuda86,target=/src/build \
    cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON -DGGML_BACKEND_DL=ON -DCMAKE_CUDA_ARCHITECTURES=86 -DGGML_NATIVE=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF -DLLAMA_BUILD_IS_DEV=OFF -DLLAMA_BUILD_COMMIT=5266f24da75dc449bd56cbed7addb9c8e4a6a73e -DLLAMA_OPENSSL=ON -DCMAKE_EXE_LINKER_FLAGS=-Wl,--allow-shlib-undefined \
    && cmake --build build --target llama-server llama-quantize --parallel 4 \
    && mkdir -p /binaries /libraries && cp build/bin/llama-server build/bin/llama-quantize /binaries/ \
    && find build -name '*.so*' -exec cp -P {} /libraries/ \;

FROM nvidia/cuda:12.8.1-runtime-ubuntu24.04@sha256:ebef3c171eeef0298e4eb2e4be843105edf3b8b0ac45e0b43acee358e8046867 AS runtime
LABEL org.opencontainers.image.source="https://github.com/ggml-org/llama.cpp" org.opencontainers.image.revision="5266f24da75dc449bd56cbed7addb9c8e4a6a73e" org.opencontainers.image.version="0.4.0"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl python3 libgomp1 libssl3t64 && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home inference
COPY --from=build /binaries/ /app/
COPY --from=build /libraries/ /app/
COPY ops/inference/serve.py ops/inference/evaluate.py ops/inference/model.lock.json /app/
ENV LD_LIBRARY_PATH=/app HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
USER 10001:10001
WORKDIR /app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s CMD curl --fail --silent http://127.0.0.1:8080/health >/dev/null || exit 1
ENTRYPOINT ["python3", "/app/serve.py"]

FROM runtime AS converter
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3-venv && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/convert_hf_to_gguf.py /src/requirements.txt /conversion/
COPY --from=build /src/conversion /conversion/conversion
COPY --from=build /src/gguf-py /conversion/gguf-py
COPY --from=build /src/requirements /conversion/requirements
RUN python3 -m venv /venv && /venv/bin/pip install --no-cache-dir -r /conversion/requirements/requirements-convert_hf_to_gguf.txt \
    && /venv/bin/pip freeze > /conversion/python-packages.lock
COPY ops/inference/model.lock.json ops/inference/prepare_model.py /conversion/
ENV HF_HUB_OFFLINE=0 TRANSFORMERS_OFFLINE=0
ENTRYPOINT ["/venv/bin/python", "/conversion/prepare_model.py"]
