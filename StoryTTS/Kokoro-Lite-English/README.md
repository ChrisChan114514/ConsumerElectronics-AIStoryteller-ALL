# Kokoro-Lite-English 学生模型蒸馏初步计划

## 1. 项目目标

为外贸产品的英文早教机制作一个专用、轻量、高并发的 TTS 学生模型。

第一版不追求复现 Kokoro-82M 的全部能力，只要求：

- 英文发音清晰，儿童能够听懂；
- 句号、逗号、问号和感叹号产生自然停顿；
- 保留基本的重音和音高变化，不把所有句子读成平调；
- 固定 1 个主要女声
- 支持故事片段和短句，不以任意语言、任意音色为目标；
- 在 RTX 5060 8 GB 上稳定运行，支持多请求并发；
- 模型可以导出为 ONNX，并使用 ONNX Runtime CUDA 或 TensorRT FP16。

当前 Kokoro TensorRT/CUDA 混合服务约为 `1.596 req/s`，这是本项目的质量基线和
速度基线。学生模型的第一阶段目标不是盲目追求参数最小，而是实现：

| 指标 | 第一阶段目标 | 说明 |
| --- | ---: | --- |
| 参数量 | 20M 到 30M | 后续可继续缩小到 10M 到 20M |
| 单请求延迟 | 比当前降低 2 倍以上 | 使用相同故事和相同 API 测量 |
| 单卡吞吐 | 至少 3 req/s | 以完整 API 为准，不只测模型 forward |
| 并发 | 4 个请求稳定成功 | 32 请求长测，错误率为 0 |
| 音频输出 | 24 kHz 单声道 WAV | 第一版不降低采样率，先保证音质可比较 |
| 音频有限值 | 100% | 不允许 NaN、Inf、全静音或爆音 |
| 时长误差 | 相对教师不超过 5% | 重点检查停顿和句尾 |

以上是工程目标，不是训练前的性能保证。最终数值必须在目标服务器上实测。

## 2. 总体路线

学生模型不是把 Kokoro 的权重简单删除一半，而是重新设计一个更小的英文单音色
TTS 网络，再使用教师模型和真实录音训练。

```text
英文文本
  -> G2P/音素转换（沿用现有 Kokoro 前端）
  -> 轻量音素编码器
  -> duration / F0 / energy 预测
  -> length regulator（按 duration 展开）
  -> 轻量声码器
  -> 24 kHz 波形
```

建议的工程顺序如下：

1. 固定一个英文女声，先训练单说话人学生模型。
2. 用 Kokoro 批量生成教师标签和教师音频。
3. 先训练学生的 duration、F0 和声学特征预测能力。
4. 再训练轻量声码器。
5. 联合微调并导出 ONNX。
6. 进行 CUDA、TensorRT 和动态 batching 测试。
7. 只有通过质量门槛后，才考虑多音色或更小模型。

## 3. 教师模型

教师模型使用当前已经验证过的 Kokoro 拆分服务或离线 PyTorch Kokoro。教师需要生成
的不只是最终 WAV，还包括能够监督学生的中间信息：

- 输入文本和标准化文本；
- 音素字符串及音素 token；
- 每个音素的 duration；
- 音素级或帧级 F0；
- energy 或 loudness；
- 教师的声学中间特征；
- 教师生成的 24 kHz WAV；
- 采样率、音频样本数、有效音频区间和质量检查结果。

教师数据建议保存为分片文件，不在每个训练 batch 中重新运行 Kokoro：

```text
teacher_data/
  train-00000.jsonl
  train-00000.npz
  valid.jsonl
  test.jsonl
  manifest.json
```

每一条样本至少包含：

```json
{
  "id": "story_000001",
  "text": "Milo opened the little red box.",
  "phonemes": "...",
  "voice": "af_heart",
  "sample_rate": 24000,
  "num_samples": 38400,
  "duration_frames": [3, 4, 5],
  "audio_path": "audio/story_000001.wav",
  "valid": true
}
```

实际实现中，较大的数组（F0、energy、声学特征和中间层）放进 `.npz` 或分片二进制
文件，JSONL 只保存索引和元数据。

## 4. 训练数据计划

### 4.1 文本覆盖范围

第一版优先覆盖早教故事，而不是泛化到所有英文：

- 5,000 到 20,000 条英文句子；
- 100 到 500 篇短故事；
- 句子长度从 3 个词到约 30 个词；
- 包含逗号、句号、问号、感叹号、冒号、引号和连字符；
- 包含数字、时间、颜色、动物、家庭成员和常用儿童词汇；
- 包含短句、长句、对话和连续叙事；
- 专门加入容易读错的专有名词、复数和过去式。

训练、验证和测试文本必须互相隔离。不能只用 `story.txt` 反复训练再用同一篇故事
判断模型是否成功。

### 4.2 教师合成数据

教师合成数据可以先生成 20,000 到 100,000 条样本，再根据磁盘和训练时间扩充。
建议每个文本至少生成一次固定 voice 的确定性音频；若模型包含随机噪声，可以为少量
样本生成多个 seed，用于让学生学习合理的变化范围，而不是记住单一波形。

教师数据的优点是能够快速获得一致的 duration、F0 和音频标签；缺点是学生会复制
教师的发音错误、爆音或不自然停顿。因此教师音频必须经过自动检查和人工抽听。

### 4.3 教师模型生成录音数据

用纯教师数据验证网络和部署流程，但这只能证明
“学生能复制教师”，不能证明最终听感达到产品要求。

## 5. 学生模型结构建议

### 5.1 文本与音素编码器

当前 Kokoro 使用较重的上下文编码器。学生模型第一版建议去掉完整 PL-BERT，改为：

- 音素 embedding：256 维；
- 4 层轻量 Transformer 或 Conformer；
- 4 个 attention head；
- feed-forward 维度 768 或 1024；
- dropout 只在训练阶段启用；
- 最大长度 256 或 384 个音素，覆盖产品故事分块。

如果实验表明 Transformer 仍然偏重，可以把编码器改为 4 层深度可分离 Conv1d。编码器
必须保留音素左右上下文，否则连读、重音和句尾语调容易变差。

### 5.2 韵律预测器

韵律预测器保留三个核心输出：

- duration：每个音素占用多少帧；
- F0：基本音高轨迹；
- energy：响度或激活强度。

建议使用 2 层 Bi-LSTM 或 4 层轻量 Conv/Conformer，隐藏维度 256。第一版不做完整
的随机 style diffusion，也不追求零样本音色迁移；音色固定后可以把 style 向量缩减
为一个可训练 embedding，甚至融合进网络参数。

### 5.3 Length regulator

学生模型使用 duration 将音素级表示展开到声学帧：

```text
音素表示 [tokens, hidden]
  + duration [tokens]
  -> 帧表示 [frames, hidden]
```

训练时可以使用教师 duration；推理时使用学生预测 duration。这样可以单独评估：

1. duration 正确但声码器较差；
2. duration 和 F0 都由学生预测；
3. 最终端到端音频。

### 5.4 轻量声码器

第一版优先保留 iSTFTNet 的思路，但缩小通道和残差块：

| 配置 | 当前 Kokoro 路线 | 学生起点 |
| --- | ---: | ---: |
| 初始通道 | 512 | 256 |
| 上采样残差块 | 6 组 | 3 或 4 组 |
| 残差块通道 | 较宽 | 256/128/64 |
| 输出 | iSTFT | iSTFT |
| 声道 | 1 | 1 |

若缩小 iSTFTNet 后音质仍然不够，再比较轻量 HiFi-GAN、HiFi-GAN V1 小配置或
Parallel WaveGAN。声码器的选择必须以完整故事的 RTF 和显存为准，不以参数量单独
判断。

## 6. 蒸馏损失

第一版不需要一开始加入复杂的 GAN 训练。建议从稳定的监督损失开始：

```text
L_total =
    1.0 * L_duration
  + 0.5 * L_f0
  + 0.2 * L_energy
  + 1.0 * L_acoustic
  + 1.0 * L_mel
  + 0.2 * L_teacher_feature
  + 0.1 * L_waveform
```

权重只是初始值，必须通过验证集调整。

### 6.1 Duration loss

对 `log(1 + duration)` 使用 L1 或 Smooth L1，避免长音素对损失完全支配。除了平均
误差，还要报告：

- 句子总帧数相对误差；
- 标点附近的停顿帧误差；
- 句尾最后 3 到 5 个音素的误差。

### 6.2 F0 和 energy loss

只在有声区域重点计算 F0 损失，并加入 voiced/unvoiced 分类损失。F0 不需要逐采样点
完全一致，但应该保持整体轮廓、句尾下降和疑问句上扬。

### 6.3 声学和频谱损失

使用多分辨率 STFT/mel 频谱损失，比较不同 FFT 窗口下的幅度和时间结构。它比只比较
波形的 MSE 更适合保留清晰度、停顿和音色。

### 6.4 教师中间特征损失

从教师前端和 decoder 选择少量对应层，通过投影层对齐通道后计算 L1 或 cosine loss。
不要强迫每一层完全相同；学生结构不同，应该只蒸馏对发音和韵律有帮助的表示。

## 7. 分阶段训练

### 阶段 0：数据和基线

- 固定教师版本、voice 和采样率；
- 生成 100 到 500 条小数据集；
- 验证 teacher label 的 shape、duration 总和和音频长度一致；
- 记录教师模型在固定测试集上的音频和指标；
- 不训练任何学生模型。

阶段 0 的退出条件是：同一文本重复生成时，教师数据可复现或随机性已被明确记录。

### 阶段 1：前端学生

- 只训练音素编码器、duration、F0 和 energy 预测器；
- 使用教师 duration/F0/energy 做监督；
- 先不训练声码器；
- 评估标点停顿、句子总时长和 F0 轮廓。

阶段 1 通过后，学生前端才能进入下一阶段。否则先修正数据、音素化或网络容量。

### 阶段 2：声码器学生

- 暂时使用教师的帧级表示或教师 duration；
- 训练轻量 iSTFTNet/HiFi-GAN 生成器；
- 先使用频谱和 waveform 损失；
- 记录不同通道数和残差块数量下的速度、显存和音频质量。

阶段 2 先追求稳定音频，不急于加入 GAN。GAN 训练可能提高自然度，但也容易造成
爆音、NaN 和训练不稳定。

### 阶段 3：联合微调

- 使用学生预测的 duration、F0 和 energy；
- 联合训练学生前端和声码器；
- 混合教师合成数据与真实录音；
- 降低学习率，保留验证集早停；
- 每个 checkpoint 都运行长文本和异常文本测试。

### 阶段 4：导出和部署

- 固定 batch 维度策略；
- 导出动态音素长度 ONNX；
- 检查 ONNX 与 PyTorch 的音频差异；
- 优先测试 ONNX Runtime CUDA；
- 再测试 TensorRT FP16；
- 最后加入 INT8，且只在完成校准后评估。

## 8. 多并发设计

学生模型本身不会自动解决并发。线上服务需要独立的请求调度层：

```text
HTTP 请求
  -> 有界队列
  -> 5 到 20 ms micro-batch 窗口
  -> 按音素长度分桶
  -> batch 推理
  -> 按样本拆分 WAV
  -> 返回结果
```

实施顺序：

1. 先做 batch size 1 的单请求正确性；
2. 支持 batch size 2，验证不同文本长度和不同 voice；
3. 支持 batch size 4；
4. 加入最大等待时间和队列长度上限；
5. 用并发 1、2、4、8 和 16 做长测。

必须分别报告：

- 单请求 latency；
- batch size；
- queue wait；
- GPU inference time；
- WAV 编码时间；
- p50、p95、错误率和吞吐。

对于长度差异很大的故事，不能把一个超长文本和多个短句强行放进同一个 batch，否则
padding 会浪费计算。应先按音素数或预计帧数分桶。

## 9. 验收测试

### 9.1 自动测试

- 200 条未见过的英文句子；
- 50 篇未见过的短故事；
- 句号、逗号、问号和感叹号组合；
- 数字、时间、缩写和引号；
- 最短句、最长允许句和接近分块上限的句子；
- 速度参数 0.75、1.0 和 1.25；
- 连续生成 1,000 条，检查 NaN、Inf、全静音和异常长度；
- 重新启动服务后重复测试，确认 engine/cache 不改变结果。

### 9.2 质量测试

至少进行以下盲听比较：

```text
教师 Kokoro
学生模型
传统基线（如当前可用的 FastPitch/HiFi-GAN）
```

重点不是追求教师完全一致，而是确认：

- 单词可懂度没有明显下降；
- 标点停顿仍然存在；
- 句尾语调没有全部变平；
- 没有明显金属音、气泡音和爆音；
- 儿童故事长时间播放不疲劳。

### 9.3 性能测试

所有性能结果都使用同一份文本、同一个 voice、相同 warmup 和相同请求数。至少记录：

```text
requests=32
concurrency=1, 2, 4, 8, 16
throughput_req_s
latency_p50_s
latency_p95_s
rtf
peak VRAM
peak RSS
GPU SM utilization
error count
```

只有完整 API 测试达到目标，才能认为学生模型成功；只测 ONNX 单次 forward 不足以
作为商用结论。

## 10. 目录和脚本规划

本目录目前只保存计划，不自动下载或训练。后续实现建议采用如下结构：

```text
Kokoro-Lite-English/
  README.md
  requirements-train.txt
  configs/
    student_base.yaml
  teacher_data/
  datasets/
    train.jsonl
    valid.jsonl
    test.jsonl
  student_model/
    text_encoder.py
    prosody.py
    vocoder.py
    model.py
  prepare_teacher_data.py
  validate_teacher_data.py
  train_frontend.py
  train_vocoder.py
  train_joint.py
  export_student_onnx.py
  server.py
  benchmark_student.py
```

脚本实现顺序：

1. `validate_teacher_data.py`；
2. `prepare_teacher_data.py`；
3. `student_model/` 的前向和单元测试；
4. `train_frontend.py`；
5. `train_vocoder.py`；
6. `train_joint.py`；
7. `export_student_onnx.py`；
8. `benchmark_student.py` 和动态 batching 服务。

## 11. 资源和时间预估

RTX 5060 8 GB 可以用于小规模学生模型训练，但需要控制 batch、序列长度和特征缓存。
训练时间取决于真实录音小时数、教师样本数、是否使用 GAN 和是否进行联合微调，不能
仅按模型参数量估计。

建议先进行一个小实验：

- 500 到 2,000 条教师样本；
- 单音色；
- 256 隐藏维度；
- 2 层韵律预测器；
- 256/128/64 声码器通道；
- 不加入 GAN；
- 训练到验证集 loss 不再明显下降。

小实验的目的只是验证数据格式、损失函数、ONNX 导出和速度方向，不代表最终质量。

## 12. 风险与回退方案

### 风险 1：学生音频变平

原因可能是 F0、energy 或标点 duration 监督不足。回退方式是扩大真实录音、提高 F0
损失权重，或暂时保留教师 duration。

### 风险 2：音质下降明显

原因可能是声码器通道过小。回退方式是从 128 通道提升到 256 通道，而不是立刻改动
整个前端。

### 风险 3：推理没有变快

原因可能是 G2P、padding、WAV 编码或 GPU kernel 调度成为瓶颈。应先测分段时间，加入
动态 batching，再决定是否继续缩小模型。

### 风险 4：ONNX/TensorRT 不稳定

默认部署使用 ONNX Runtime CUDA。TensorRT 只作为经过逐句验证的可选后端；任何 NaN、
engine cache 错误或 RAM 异常都自动回退到 CUDA FP32。

### 风险 5：训练数据复制教师缺陷

不能只用教师 WAV。应加入真实录音、人工抽听和未见文本测试；教师只负责提供发音、
时长和韵律的稳定监督。

## 13. 明确的决策门槛

在开始大规模训练前，需要通过以下小实验门槛：

1. 前端学生在验证集上的句子总时长误差小于 5%；
2. 标点附近停顿没有系统性消失；
3. 声码器生成音频全部有限且无全静音；
4. ONNX CUDA 推理与 PyTorch 音频没有明显结构性差异；
5. batch size 2 至少比 batch size 1 有可测吞吐收益；
6. 端到端速度确实优于当前约 `1.596 req/s` 基线。

如果第 6 项不成立，就暂停学生模型扩展，先优化 batching 或保留当前 Kokoro；如果
质量门槛不成立，则学生模型只能作为实验分支，线上继续使用 Kokoro 质量路径。

## 14. 参考方向

- Kokoro-82M 模型卡：https://huggingface.co/hexgrad/Kokoro-82M
- StyleTTS 2：https://arxiv.org/abs/2306.07691
- FastSpeech 2：https://arxiv.org/abs/2006.04558
- 当前项目的 Kokoro 重新导出与混合 GPU 服务：`../kokoro_TensorRT_FP16/`

当前已经实现阶段 0 和阶段 1 的代码，但不会自动下载大规模数据、启动长时间训练或
替换现有 Kokoro 服务。当前代码可以生成教师数据、校验标签、训练学生前端并导出
ONNX；学生声码器和动态 batching 属于后续阶段。教师服务必须由操作者显式设置
`KOKORO_ENABLE_TEACHER_LABELS=1` 后重新启动，标签接口只用于离线数据准备。

## 当前代码快速开始

## 当前数据生产主流程（IoT -> DeepSeek -> Kokoro 教师）

训练数据不从固定 `story.txt` 扩展，也不从数据库凭空拼接。正确的数据流是：

```text
PC 虚拟终端模拟插入 1/2/3/4 张卡（覆盖 C001-C128）
  -> MQTT IoT 请求
  -> WebService /api/stories/generate
  -> DeepSeek-V4-Flash 生成英文故事
  -> WebService /api/speech/synthesize
  -> Kokoro TensorRT FP16 教师服务（2229）
  -> 新数据库 kokoro_TensorRT_FP16 保存故事、单卡教师 WAV 和元数据
  -> IoT 将当前 WAV 转成临时 MP3，供 ESP32 的 MP3 解码器播放
```

先确认教师服务、WebService、IoT 三个进程都已启动，并且 WebService 的 `.env` 已设置
`TTS_PROVIDER=kokoro`、`TTS_BASE_URL=http://127.0.0.1:2229` 和
`MYSQL_DATABASE=kokoro_TensorRT_FP16`。然后在 PC 终端运行：

```bash
cd /home/cc/Desktop/AIStoryteller/WebService
npm run iot:generate-training -- --requests 128 --concurrency 2
```

脚本每次等待 `story.ready`，因此只有 DeepSeek 文本生成成功且 Kokoro WAV 已经生成后
才会记录一条训练输入。输出默认是
`StoryTTS/Kokoro-Lite-English/datasets/iot_story_requests.jsonl`，每行含有
`story_id`、`text` 和实际使用的卡片组合。`--requests` 可扩大到 500、2000 或更多；
`--concurrency` 建议先用 2，避免同时请求 DeepSeek 时触发限流。

教师标签和音频缓存仍通过 Kokoro 的离线标签接口完成。数据生产前临时启动：

```bash
cd /home/cc/Desktop/AIStoryteller/WebService/StoryTTS/kokoro_TensorRT_FP16
KOKORO_ENABLE_TEACHER_LABELS=1 ./run_server.sh
```

然后把 IoT 生成的 JSONL 交给教师数据准备脚本：

```bash
cd /home/cc/Desktop/AIStoryteller/WebService/StoryTTS/Kokoro-Lite-English
/home/cc/miniforge3/envs/pytorch/bin/python prepare_teacher_data.py \
  --teacher-url http://127.0.0.1:2229 \
  --text-file datasets/iot_story_requests.jsonl \
  --output-dir teacher_data_iot --max-items 0
/home/cc/miniforge3/envs/pytorch/bin/python validate_teacher_data.py --data-dir teacher_data_iot
```

`prepare_teacher_data.py` 会再次明确调用同一个 Kokoro 教师生成 WAV、duration、F0 和
energy 标签；数据库中的单卡 WAV 用于产品缓存和抽听，多卡故事只保存文本和终端播放痕迹；
`teacher_data_iot` 用于训练分片。IoT 目录中的 MP3 是设备播放缓存，不作为学生模型训练数据。
训练集和测试集按文本哈希拆分，不能把同一故事同时放进训练和测试。

数据库重置（会永久删除旧 `story_machine` 数据库）使用：

```bash
cd /home/cc/Desktop/AIStoryteller/WebService
bash bash/reset_kokoro_database.sh --yes
```

执行前必须停止 WebService/IoT PM2 进程；脚本只允许目标库已经配置为
`kokoro_TensorRT_FP16` 时运行，且会在导入五张表并验证成功后删除旧库。

先在教师目录启动标签接口（这会重启教师服务）：

```bash
cd ../kokoro_TensorRT_FP16
KOKORO_ENABLE_TEACHER_LABELS=1 ./run_server.sh
```

另一个终端执行：

```bash
cd ../Kokoro-Lite-English
/home/cc/miniforge3/envs/pytorch/bin/python make_text_manifest.py \
  ../story.txt datasets/story_seed.jsonl
/home/cc/miniforge3/envs/pytorch/bin/python prepare_teacher_data.py \
  --teacher-url http://127.0.0.1:2229 \
  --text-file datasets/story_seed.jsonl \
  --max-items 20
/home/cc/miniforge3/envs/pytorch/bin/python validate_teacher_data.py
```

先用小数据确认链路，再逐步扩大样本量。训练第一版学生前端：

```bash
/home/cc/miniforge3/envs/pytorch/bin/python train_frontend.py \
  --data-dir teacher_data --epochs 30 --batch-size 16 \
  --output checkpoints/frontend.pt
/home/cc/miniforge3/envs/pytorch/bin/python export_student_onnx.py \
  --checkpoint checkpoints/frontend.pt \
  --output models/kokoro-lite-frontend.onnx
```

教师数据生成脚本使用 `/v1/teacher/labels` 返回的真实 duration，不从 WAV 静音区间
猜测时长；普通 `/v1/audio/speech` 接口和默认安全配置不受影响。生产或普通测试完成
后，应停止教师服务并不再设置 `KOKORO_ENABLE_TEACHER_LABELS=1`。
