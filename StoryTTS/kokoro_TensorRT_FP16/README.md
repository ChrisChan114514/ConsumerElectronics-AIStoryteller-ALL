# Kokoro 拆分 ONNX GPU 服务

本目录不再给官方整图 ONNX 强行补 shape。新的导出流程从 Kokoro v1.0 PyTorch
权重重新导出两个动态 ONNX 图：

- `frontend`：BERT、韵律和时长预测，使用 TensorRT FP16。
- `decoder`：主机端按预测时长展开后合成波形，默认使用 ONNX Runtime CUDA FP32。

主机端展开删除了原整图中的 `Loop`、`SequenceEmpty`、`SequenceInsert` 和
`ConcatFromSequence`，导出的拆分 PyTorch 模型与原模型逐样本完全一致。默认采用混合
Provider，是因为 RTX 5060 + TensorRT 10.11 将完整声码器降为 FP16 时会偶发产生
NaN；把敏感算子全部回退又会切成 28 个 TensorRT engine，进程 RAM 接近 9 GiB，
不适合服务。

## 一次性准备

复用现有 `/home/cc/miniforge3/envs/pytorch`：

```bash
cd /home/cc/Desktop/AIStoryteller/WebService/StoryTTS/kokoro_TensorRT_FP16
./setup_pytorch_env.sh
./download_export_assets.sh
./download_models.sh
```

`download_export_assets.sh` 默认使用 `hf-mirror.com` 下载原始 checkpoint 和配置，
并校验固定大小与 SHA-256。`download_models.sh` 仍负责 voices；旧的官方整图 ONNX
只作为对照，不参与默认服务。

## 重新导出模型

```bash
/home/cc/miniforge3/envs/pytorch/bin/python export_tensorrt_models.py
```

输出位于 `models/split/`：

```text
kokoro-frontend.onnx
kokoro-decoder.onnx
kokoro-frontend.fp16.onnx
kokoro-decoder.fp16.onnx
```

脚本会严格检查 checkpoint 参数、ONNX 结构和 CPU ONNX 输出。服务默认读取两个
FP32 源图，由 Provider 对前端选择 FP16；这样 TensorRT 可自行保留必须使用 FP32
的层，而不会读取不稳定的纯 FP16 声码器图。

## 检查 TensorRT 前端

```bash
/home/cc/miniforge3/envs/pytorch/bin/python split_provider_check.py
```

第一次会构建前端 engine，通常约一分钟。成功结果必须包含至少一个
`TensorrtExecutionProvider` 节点。不要用 `Ctrl+Z` 停止构建；它只暂停进程并继续
占用内存，应使用 `Ctrl+C`。

## 启动服务

```bash
./run_server.sh
curl http://127.0.0.1:2229/health
```

健康检查中的关键字段应为：

```json
{
  "providers": {
    "frontend": "TensorrtExecutionProvider",
    "decoder": "CUDAExecutionProvider"
  },
  "workers": 4
}
```

默认 4 个线程共享同一个 ONNX session，不会加载 4 份模型。可用
`KOKORO_TRT_WORKERS=1 ./run_server.sh` 做串行基准。该服务默认端口为 2229，接口与
现有 Kokoro 服务一致。

## 样本与并发测试

```bash
/home/cc/miniforge3/envs/pytorch/bin/python sample.py \
  --base-url http://127.0.0.1:2229/v1 \
  --output samples/kokoro_story_hybrid.wav

/home/cc/miniforge3/envs/pytorch/bin/python bench.py \
  --base-url http://127.0.0.1:2229/v1 --concurrency 1 --requests 32
/home/cc/miniforge3/envs/pytorch/bin/python bench.py \
  --base-url http://127.0.0.1:2229/v1 --concurrency 4 --requests 32
/home/cc/miniforge3/envs/pytorch/bin/python bench.py \
  --base-url http://127.0.0.1:2229/v1 --concurrency 8 --requests 32
```

2026-08-26 在 RTX 5060 上对本目录 `story.txt`（生成音频约 51 秒）的实测：

| 服务槽 / 客户端并发 | 吞吐 | p50 | 结果 |
| --- | ---: | ---: | --- |
| 1 / 1 | 0.787 req/s | 1.274 s | 8/8 成功 |
| 1 / 4 | 0.781 req/s | 5.048 s | 8/8 成功，串行排队 |
| 4 / 4 | 1.596 req/s | 2.471 s | 32/32 成功 |
| 4 / 8 | 1.561 req/s | 5.098 s | 32/32 成功，超过 4 个请求开始排队 |

4 并发长测时 GPU SM 利用率主要为 90% 到 100%，峰值总显存约 3.0 GiB（包含桌面
进程），说明 GPU 已接近饱和。继续增加客户端并发主要增加等待时间，不能线性提高
吞吐。

## 学生模型教师标签接口

`Kokoro-Lite-English/prepare_teacher_data.py` 需要教师返回逐音素 duration，因此教师
目录提供了一个默认关闭的离线接口。只在数据生成期间启用：

```bash
KOKORO_ENABLE_TEACHER_LABELS=1 ./run_server.sh
```

启用后可访问 `POST /v1/teacher/labels`；它返回音素、duration、padding 帧和每批
音频长度。完成数据生成后必须停止该进程，并用未设置
`KOKORO_ENABLE_TEACHER_LABELS` 的命令重新启动普通服务。标签接口不应暴露到公网，
也不属于线上 TTS API。

## 全 TensorRT 声码器仅供实验

如需复现实验而不是运行服务：

```bash
/home/cc/miniforge3/envs/pytorch/bin/python split_provider_check.py \
  --component decoder --experimental-full-trt
```

全 TensorRT 声码器可能占用约 9 GiB RAM，并且动态 cache 曾出现加载失败及回退
CPU。即使构建成功，也不能据此用于商用服务。强制启动实验模式的命令是：

```bash
KOKORO_DECODER_PROVIDER=tensorrt KOKORO_TRT_WORKERS=1 ./run_server.sh
```
