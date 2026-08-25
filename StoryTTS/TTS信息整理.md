
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
