
| 方案                   | 约每篇成本        | 10 万篇      | 英文故事表现             | 商用情况                      | 建议          |
| ---------------------- | ----------------- | ------------ | ------------------------ | ----------------------------- | ------------- |
| 托管 Kokoro API        | US$0.0013–0.0016 | US$130–160  | 自然、清晰，有轻度表现力 | Apache 2.0                    | 综合首选      |
| Cloudflare MeloTTS     | US$0.0004         | US$40        | 清晰，但情感较弱         | 模型 MIT，Cloudflare 商业服务 | 最低成本/降级 |
| 本地 Kokoro + RTX 5060 | 无调用费          | 电费和维护费 | 比传统小模型自然         | Apache 2.0                    | 本地主力候选  |
| Chatterbox-Turbo       | 无调用费          | 电费和维护费 | 情绪和叙事更好           | MIT                           | 高质量档实验  |
| CosyVoice3 0.5B        | 无调用费          | 电费和维护费 | 情感控制较强             | Apache 2.0，维护者确认可商用  | 第二阶段      |
| AWS Polly Standard     | US$0.008          | US$800       | 稳定但偏普通             | 明确可商用                    | 灾备          |
| AWS Polly Neural       | US$0.032          | US$3,200     | 更自然                   | 明确可商用                    | 高可靠灾备    |

## `Kokoro-82M` TTS模型方案


| 服务                          | 当前价格                            | 并发与特点                                           | 建议           |
| ----------------------------- | ----------------------------------- | ---------------------------------------------------- | -------------- |
| DeepInfra，经 OpenRouter 调用 | `$0.62 / 100万字符`               | OpenAI 兼容 TTS 接口；Serverless；固定并发额度未公开 | 最低成本       |
| Together AI                   | `$4 / 100万字符`                  | 支持流式、MP3/WAV/raw、声线混合；宣称约97ms首包延迟  | 最适合首期生产 |
| Replicate                     | 典型约`$0.0018/次`，按GPU时间浮动 | T4、自动扩容，创建任务上限600次/分钟；可能冷启动     | 测试或备用     |
| 自建 Kokoro-FastAPI           | 无字符费用                          | 自己承担显卡、电费、队列、监控和故障恢复             | 量大后使用     |

DeepInfra: [deepinfra.com/hexgrad/Kokoro-82M](https://deepinfra.com/hexgrad/Kokoro-82M)

Together AI：[www.together.ai/models/kokoro-82m](https://www.together.ai/models/kokoro-82m)

Hugging face介绍：[huggingface.co/hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)


| 优先级 | 模型 | GPU/并发路线 | 判断 |
|---|---|---|---|
| 1 | Matcha-TTS + HiFiGAN-small | ONNX Runtime CUDA、非自回归、批量推理 | 最值得先实测，英语故事场景合适 |
| 2 | FastPitch + HiFiGAN | TensorRT/Triton、动态批处理 | 最有希望做成稳定高吞吐生产服务 |
| 3 | MeloTTS | PyTorch CUDA、VITS | 部署简单、音质要求低时值得作为对照组 |
| 4 | Supertonic 3 | 批量推理、低采样步数 | 潜在极快，但官方 GPU 路径不够成熟 |
| 5 | CosyVoice TensorRT | TensorRT-LLM/Triton | 更重，偏向音质和能力，不适合单纯追求最快 |
| 6 | VibeVoice-Realtime 0.5B | CUDA 流式生成 | 首包快，但完整故事吞吐量未必高 |

docker-pytorch镜项资源：
FASTPITCH_PYTORCH_IMAGE=docker.m.daocloud.io/pytorch/pytorch \
docker compose build

极限优化推理kokoro_TensorRT_FP16测试结果

| 执行槽/并发 | 吞吐 | p50 | 结果 |
|---|---:|---:|---|
| 1/1 | 0.787 req/s | 1.274s | 8/8 |
| 4/4 | 1.596 req/s | 2.471s | 32/32 |
| 4/8 | 1.561 req/s | 5.098s | 32/32 |


成功的测试：
cd /home/cc/Desktop/AIStoryteller/WebService/StoryTTS/kokoro_TensorRT_FP16

/home/cc/miniforge3/envs/pytorch/bin/python bench.py \
  --base-url http://127.0.0.1:2229/v1 \
  --concurrency 4 \
  --requests 32

这个版本的核心思路是“拆开模型，分别用最适合的 GPU 加速方式运行”。
Kokoro 原始推理大致分两步：
1. 前端：把文本转换为音素，预测每个音素持续多久、语调和韵律。
2. 声码器：根据这些特征生成最终 24 kHz 音频波形。

本次加速路径是：
- 前端使用 TensorRT FP16
  - FP16 将大量神经网络计算从 FP32 降到半精度。
  - RTX 5060 的 Tensor Core 对 FP16 矩阵计算很快。
  - TensorRT 会融合算子、选择更快的 CUDA kernel，并缓存优化后的 engine。
- 声码器使用 ONNX Runtime CUDA FP32
  - 声码器包含 InstanceNorm、Snake 激活、随机噪声和 iSTFT 等对精度敏感的算子。
  - 强制整段 TensorRT FP16 会偶发 NaN，或造成大量子图切分、RAM 暴涨。
  - 因此保留 CUDA FP32，稳定性和音质更可靠，同时仍在 RTX 5060 上计算，不是 CPU 推理。
- 并发使用 4 个执行线程，共享一份模型
  - 不需要启动 4 个容器，也不需要加载 4 份模型。
  - 同一个 GPU 上可同时提交多条推理任务，让 GPU 持续处于高利用率。
  - 你的实测 4 并发约 1.6 请求/秒，GPU SM 长时间接近 90% 到 100%，说明显卡已被有效利用。

可以把它理解为：

文本
  -> TensorRT FP16 前端：快速预测发音、时长、韵律
  -> CUDA FP32 声码器：稳定生成音频
  -> WAV 返回




