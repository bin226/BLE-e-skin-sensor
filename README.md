# BLE E-Skin Sensor

基于 **ESP32、CS1237 和微信小程序** 的电子皮肤微弱电压采集系统。ESP32 使用 MicroPython 读取 ADC 数据并通过 BLE 发送电压和时间戳；微信小程序负责扫描设备、显示实时曲线，并将电压事件转换为二进制字符。

## 功能

- 读取 CS1237 的 24 位 ADC 数据
- 启动零点校准及微伏（μV）换算
- 通过 BLE 实时发送电压和时间
- 微信小程序扫描、连接并显示电压曲线
- 检测电压上升/下降事件并编码为 `1`/`0`
- 每 5 bit 转换为字母 `A–Z`，`11111` 表示空格

## 系统结构

```mermaid
flowchart LR
    A[电子皮肤] --> B[CS1237 ADC]
    B -->|DRDY/DOUT + SCLK| C[ESP32]
    C -->|BLE| D[微信小程序]
    D --> E[电压曲线与字符输出]
```

## 项目结构

```text
├── main.py                         # ESP32 MicroPython 固件
└── Ble e-skin Sensor_MiniProgram/  # 微信小程序
    ├── index/                      # BLE 扫描页
    └── deviceDetail/               # 数据显示与事件识别页
```

## 硬件连接

| CS1237 | ESP32 | 固件配置 |
| --- | ---: | --- |
| DRDY/DOUT | GPIO 48 | `DRDY_PIN` |
| SCLK | GPIO 45 | `SCLK_PIN` |

电子皮肤接入 CS1237 的差分模拟输入。仓库未提供完整原理图，电源、模拟输入、参考电压和共地方式请以实际模块资料为准。

## 快速开始

### ESP32

1. 为开发板刷入支持 BLE 的 MicroPython 固件。
2. 按上表连接 CS1237，并连接电子皮肤传感器。
3. 使用 Thonny、`mpremote` 等工具将 `main.py` 上传到开发板根目录。
4. 重启开发板并等待零点校准完成。

设备将以 `ESP32-CS1237-Sensor` 为名称进行 BLE 广播。

### 微信小程序

1. 使用微信开发者工具导入 `Ble e-skin Sensor_MiniProgram`。
2. 将 `project.config.json` 中的 AppID 占位值 `******` 替换为自己的 AppID。
3. 使用支持 BLE 的手机进行真机调试，并授予所需蓝牙权限。
4. 在扫描列表中选择 `ESP32-CS1237-Sensor`，查看实时数据。

## BLE 协议

| 项目 | 值 |
| --- | --- |
| 设备名称 | `ESP32-CS1237-Sensor` |
| Service UUID | `0x181A` |
| Characteristic UUID | `0x2A58` |
| 特征属性 | Read、Notify、Write |
| 通知数据 | 8 bytes，Little-endian |

通知数据由两个连续的 32 位浮点数组成：

| 偏移 | 类型 | 内容 | 单位 |
| ---: | --- | --- | --- |
| 0–3 | Float32 | 零点校准后的电压 | μV |
| 4–7 | Float32 | ESP32 启动后的时间 | s |

对应的 Python 数据格式为：

```python
voltage_uv, timestamp_s = struct.unpack("<ff", payload)
```

向特征值写入单字节 `0xFF` 可重启 ESP32；当前微信小程序没有提供该操作界面。

## 主要参数

固件默认使用 `VREF = 3.3 V`、`PGA_GAIN = 128`，CS1237 配置为通道 1、10 Hz。主循环末尾等待 200 ms，实际 BLE 通知频率还受 ADC 就绪时间影响。

小程序默认使用 140 μV 上升阈值、50 μV 下降阈值和 20 μV/s 最小变化率。更换传感器或采集电路后，应重新校准参考电压和事件阈值。

## 注意事项

- GPIO 45/48、参考电压和输入范围需与实际开发板及 CS1237 模块匹配。
- 启动校准期间应保持传感器输入稳定。
- 建议使用微信真机调试 BLE 功能。
- 本仓库尚未提供完整电路图、物料清单和 `LICENSE` 文件。
