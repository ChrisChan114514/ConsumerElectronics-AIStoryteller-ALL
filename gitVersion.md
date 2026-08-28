## 0.01 产品需求梳理与大致方案

### 0.01.1

我是一个消费电子嵌入式、硬件电路、物联网全栈工程师，现在我要做一个学龄前AI故事机，大致构思如下

产品拓扑：

输入模块：

1. 简易光电黑白格码卡片（注意不是ISBN国际标准的那种），总共6格，那就可以识别64种卡片编码；这个卡片插到装置的槽内，有六组光电传感器进行六格黑白码的传感（六组最好是自己使用贴片的光电传感器硬件电路，也可以在项目初期用模块）
2. 卡片槽先暂时3个，可以不插满就开始讲故事；要开始讲故事，必须按下开始键；插入卡片后，立即播放FLASH中的语音，比如播放dog的真人语音

这个卡片是这样的，各个卡片代表一个短词，比如挖掘机、苹果、公主之类，装置通过扫描这些卡片（注意了，小孩可以随时刷卡片，包括开机时候没有在讲故事的时候，以及在讲故事的时候，刷卡就暂存卡片信息，然后小孩如果按下了多功能键，就立即上传新的关键词（这个多功能按键又包括暂停和 上传，在刷卡后，如何做到适合小孩的简单逻辑，又能兼顾暂停和故事的实时调整功能））

1. 三个按钮输入：开关机键，音量控制键，发送需求/暂停故事播放综合按键
2. 通过蓝牙连接的android手机软件/web平台（项目后期）：家长可以设置小孩的nickname，年龄等信息，这样可以个性化故事服务；这个设置，直接传入故事机的掉电存储（可以是EEPROM之类）
3. 蓝牙网络输入（下行）模块（升级版wifi下行模块）：对于装置，所有的故事，都是通过家长的手机设置网络转发，或者是蓝牙设置好wifi后，进行wifi的网络连接；所有的AI故事，都要通过网络连接，装置联网后请求服务器，服务器连接LLM-API后，生成好故事再回传装置终端

输出模块：

1. 一个喇叭，可以输出高品质讲故事人声，以及等待故事生成的过程的中舒缓音乐、高品质人声（这个可以存入flash）等
2. 一个LED灯组，可以简单提示系统状态，主要是LED合成笑脸、哭脸等，提示状态的同时，也能提供玩具的趣味性

关键控制流程：

1.开机后，可以直接准备好扫描卡片，小孩可以插入卡片，然后识别并放入RAM；最重要的是让ESP32自行寻找手机蓝牙网络。或者是手机蓝牙上位机提供的wifi信息，使得设备可以联网

2.识别卡片后，播放响应的语音（不联网也能用）

3.小孩在插入一些卡片后，按下开始键（多功能键）后，在联网模式下，可以开始连接网络，请求LLM开始生成故事，在第一段生成后，开始讲故事，前台终端在讲故事，后台在生成，并做好时间的控制，就是MCU后台会接收服务器LLM-API生成的故事，这个时间要把握好，尽量没有卡顿（真的来不及，进一小段舒缓的FLASH音乐，然后继续讲故事）

关键控制器：

ESP32（终端全部主控），linux公网服务器（已经具备实体高性能服务器和公网云服务器，且配置了frp内网穿透设施，可以供所有终端访问）

参考产品网址：[www.amazon.com/Storytelling-Instantly-Screen-Free-Subscription-Montessori/dp/B0GZMXMJWV/ref=sr_1_1_sspa?crid=3FT61BILMMRNE&amp;dib=eyJ2IjoiMSJ9.DseNXh6HY1yOmf-stw7040-ci-e6S7AjZxK3Yd-NxWBQTWs8iCiUMoaxMkbfcKXCFukMz03IQ7icDfug1TLdlNjpvQ46dl-HrtBA0l-f8JWcc_M_ikNQwM7DdscIZAPMVEp5HmKttX06W1v8TQVH_iOZ3_O8qLb2PEHU1CJZL5oDFDbRWVvaOPU2MtkgSegfPH9D9Hg20iQ1s__EjfAWf93UqdjRi81l31YzW7Y430Ztq5NFaiRlusCNUWMJNlnhBY-HAAEL9OkvHUQWRoloF234KoQ3dlfIH7LMr9osDwY.mSf_otJXAzDjxm5cgd2YxYqsDeXAbtQHxC-AYbAmFk4&amp;dib_tag=se&amp;keywords=card%2Bstory%2Breader&amp;qid=1786347258&amp;sprefix=card%2Bstory%2B%2Caps%2C510&amp;sr=8-1-spons&amp;sp_csd=d2lkZ2V0TmFtZT1zcF9hdGY&amp;th=1](https://www.amazon.com/Storytelling-Instantly-Screen-Free-Subscription-Montessori/dp/B0GZMXMJWV/ref=sr_1_1_sspa?crid=3FT61BILMMRNE&dib=eyJ2IjoiMSJ9.DseNXh6HY1yOmf-stw7040-ci-e6S7AjZxK3Yd-NxWBQTWs8iCiUMoaxMkbfcKXCFukMz03IQ7icDfug1TLdlNjpvQ46dl-HrtBA0l-f8JWcc_M_ikNQwM7DdscIZAPMVEp5HmKttX06W1v8TQVH_iOZ3_O8qLb2PEHU1CJZL5oDFDbRWVvaOPU2MtkgSegfPH9D9Hg20iQ1s__EjfAWf93UqdjRi81l31YzW7Y430Ztq5NFaiRlusCNUWMJNlnhBY-HAAEL9OkvHUQWRoloF234KoQ3dlfIH7LMr9osDwY.mSf_otJXAzDjxm5cgd2YxYqsDeXAbtQHxC-AYbAmFk4&dib_tag=se&keywords=card%2Bstory%2Breader&qid=1786347258&sprefix=card%2Bstory%2B%2Caps%2C510&sr=8-1-spons&sp_csd=d2lkZ2V0TmFtZT1zcF9hdGY&th=1)

taobao:

https://item.taobao.com/item.htm?abbucket=3&id=848748715994&mi_id=0000bUIqQ4h3xgz7MP3F0EeQpfsqDxvrfE0h6-BnPOdiOQs&ns=1&skuId=5647772405007&spm=a21n57.1.hoverItem.6&utparam=%7B%22aplus_abtest%22%3A%22e4abd1858a0ab9d414196841417b3d6f%22%7D&xxc=taobaoSearch

## 0.02 构建web初步的服务

### 0.02.1

D:\Game2\ConsumerElectronics\wxDemo_StoryMachinePlan\Plan\初步计划.md 根据这边的产品计划，先将这边的故事生成的网络服务建立起来，放在D:\Game2\ConsumerElectronics\wxDemo_StoryMachinePlan\WebService 文件夹里面；同时 D:\Game2\ConsumerElectronics\wxDemo_StoryMachinePlan> 这边的代码库，已经git init了，再写一个gitingone，将ref里面的，以及word这些文档，不加入git里面；继续，先构建这边的故事生成的网络服务建立起来，仅到LLM调用，并做一个前端的控制测试台

### 0.02.2

端口改为2210

### 0.02.3

再webservice/bash里面写一组脚本，就是再linux系统里面，写开启服务并挂载到PM2开机自启的脚本，另外还有关闭服务的脚本，注意这台电脑是windows，不要在本机测试，写好即可，在远程linux电脑内，/home/cc/Desktop/AIStoryteller/WebService 全套脚本在此

### 0.02.4

这个DeepseekAPI在github库里面脱敏，反正都是自己的私人库

### 0.02.5

前端都错位了，本机电脑也可以跑服务，自检修复一下；然后就是这样，这个其实是一个外贸产品，就是主要是要生成英文的故事，所以就是这个测试控制台可以生成英文的故事内容；然后是这样，现在不是三个卡槽了，而是一个卡槽，但是允许小孩用户累计这个卡片数量，最多是4个最新的卡槽的情况，所以就是说，故事的生成，有1、2、3、4四种卡槽的形式；然后现在设计是128卡，你要设计好，作为小孩的识字（单词）、故事生成玩具，这128个单词哪些比较合适，选出来并应用在测试台里面（中英文同一个单词，主要服务外贸英文环境）

### 0.02.6

建立一个MySQL数据库，就是这样，在用户使用的过程中，对于这些卡片生成的故事及其语音，建立一个数据库；就是总共128种牌，1、2、3、4任意组合，那么组合数量是有限的，每种有限的组合，上限100种故事，单卡上限200个故事；如果这种组合数据库没有满，就要新生成语音与故事文本，否则就直接随机调用没有听过的故事（每个设备ID记录一下，尽量就是讲没有讲过的故事），如果都讲过，那就讲时间久远一些之前的，所以这个用户听过哪些，也要建立相应的数据库；现在就是设备暂时没有，只是电脑测试一下，那就分为PC端测试用户和设备用户，但是统计逻辑是一样的

### 0.02.7

测试控制台设计第二个界面，就是查看现在的数据库里面有哪些已经生成的故事以及音频/用户ID访问与使用情况，并检查数据库的连接情况

### 0.02.8

这个 Generate English story 按钮，功能改为，生成故事文本和音频，直接一次性全部生成完成，修改代码

## 0.03 IoT下发故事包

### 0.03.1

很好，这个下发服务已经测试完成了，ESP32可以完美的接收到这个音频并流畅的播放，然后现在是这样，就是再这个总的生成故事、生成音频的D:\Game2\ConsumerElectronics\wxDemo_StoryMachinePlan\WebService Web服务内的IoT文件夹，开放2215端口进行物联网层（就是我会手动放到公网服务器上，你在这边简单修改代码，并在本地测试，ESP32先连接本机的2215端口即可）的故事音频的请求和下发服务测试，然后再D:\Game2\ConsumerElectronics\wxDemo_StoryMachinePlan\ESP32-S\I2S\4I2S_IoTMp3_Test 这边写ESP32相应的终端，这种公网的物联网传输，是使用MQTT进行设备准入控制、数据包下发、终端反馈上行，是不是这样的结构更加好？

控制顺序是这样，首先，ESP32会登录到这个MQTT平台，然后连接后，有一个声音进行提示（比如一个1khz音频信号，0.5s 两声），然后发送测试指令（就是生成故事的基本信息，现在模拟卡已经插入了 C001，C002，C002，C004四张），然后生成相应故事，开始生成后，IoT平台下发此数据包，然后声音提示是（比如一个2khz音频信号，0.25s 两声），生成结束后，再次下发数据包提示，然后音频提示（比如一个500hz音频信号，0.5s 1声），然后开始ESP32-S\I2S\4I2S_IoTMp3_Test 这边测试的音频循环流播过程（添加一轮音频播放结束后，播放750Hz 0.25s 提示音 三声，然后开始下一轮流播）

### 0.03.2

修改一下这边的WebService\bash\start_pm2.sh，在2215 IoT服务在服务启动的时候，也一并打开；同时修改2210的前端控制测试台，写一个第三个页面，就是监控2215端口MQTT的连接终端数量和动作统计

### 0.03.3

你在这个WebService\StoryTTS 文件夹里面，设计多个Nvida RTX5060 的部署方案，每一个就是一个子文件夹，比如WebService\StoryTTS\Kokoro，进行一个多并发的测试（不在本机，就是python代码和requirement写好，如果py不够快或者不合适，可以用其他语言，我都去搞定）,并生成测试音频（讲一段固定的故事，我听听比较质量），最终我来选择到底使用哪个模型；在本机不做测

### 0.03.4

现在本地的kokoro-82M（RTX5060）服务，达到了78.03的比率，可以用于语音推理，现在完全放弃了doubaoTTS，而是使用kokoro进行实验；所有语音，在当前版本，都使用kokoro_TensorRT_FP16推理方式进行

正在训练一个学生模型，就是更加适用于故事机的较低音质需要

### 0.03.5

很好，现在联合修改Webservice/IoT网络服务层，以及在ESP32\ESP32-S3\IoT\WithEdgeTTS 建立有EdgeTTS的请求；在IoT网络服务代码中，就是检查代码，是否允许解耦输出，就是先请求LLM，再请求对应的语音，注意是对应的语音（这个想服务器请求语音，是可能会请求可能不会请求，因为有可能EdgeTTS网络转台很好，就直接请求EdgeTTS了）；那么这个ESP32代码的流程是这样，先上电开机、测试I2S及测试音；然后测试EdgeTTS的网络情况，如果EdgeTTS可以服务，I2S音响讲Microsoft Edge TTS OK！（请求EdgeTTS讲这个）如果评估不可以，就说发出三个0.25s的2khz声音，然后，如果是EdgeTTS可以的情况，那么就只请求LLM而没有120.26.111.75的语音，语音从edgeTTS请求；如果edgeTTS不可以，那就像现在这样ESP32\ESP32-S3\IoT\NoEdgeTTS 正常进行全盘120.26.111.75的请求
