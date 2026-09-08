import bluetooth
from machine import Pin, ADC, reset  # 导入 reset 函数
import time
from struct import pack

# ========================= BLE 配置 =========================
BLE_NAME = "ESP32-CS1237-Sensor"
SERVICE_UUID = bluetooth.UUID(0x181A)  # 自定义服务UUID
CHAR_UUID = bluetooth.UUID(0x2A58)     # 特征值UUID
BLE_IRQ_CENTRAL_CONNECT = 1
BLE_IRQ_CENTRAL_DISCONNECT = 2
BLE_IRQ_GATTS_WRITE = 3

# ========================= CS1237 配置 ======================
DRDY_PIN = 48   # DRDY/DOUT引脚
SCLK_PIN = 45   # SCLK引脚
VREF = 3.3      # 参考电压
PGA_GAIN = 128  # PGA增益

# 初始化引脚
drdy = Pin(DRDY_PIN, Pin.IN)
sclk = Pin(SCLK_PIN, Pin.OUT)

# ====================== BLE服务初始化 =======================
class BLECSV1237Sensor:
    def __init__(self, ble):
        self._ble = ble
        self._ble.active(True)
        self._ble.irq(self._irq)
        self._connections = set()

        service = (
            SERVICE_UUID,
            [(CHAR_UUID, bluetooth.FLAG_READ | bluetooth.FLAG_NOTIFY | bluetooth.FLAG_WRITE)],
        )
        ((self._handle,),) = self._ble.gatts_register_services([service])
        self._ble.gatts_write(self._handle, pack('<ff', 0.0, 0.0))
        self._advertise()

    def _irq(self, event, data):
        if event == BLE_IRQ_CENTRAL_CONNECT:
            conn_handle, _, _ = data
            self._connections.add(conn_handle)
            print("Device connected")
        elif event == BLE_IRQ_CENTRAL_DISCONNECT:
            conn_handle, _, _ = data
            if conn_handle in self._connections: # Check if actually in set before removing
                self._connections.remove(conn_handle)
            self._advertise()
            print("Device disconnected")
        elif event == BLE_IRQ_GATTS_WRITE:  # 新增：处理写入事件
            conn_handle, value_handle = data
            if value_handle == self._handle:
                value = self._ble.gatts_read(self._handle)
                if value == b'\xff':  # 检查是否为重启指令
                    print("Received restart command, restarting...")
                    reset()  # 重启设备

    def _advertise(self):
        payload = self._advertising_payload(
            name=BLE_NAME,
            services=[SERVICE_UUID]
        )
        self._ble.gap_advertise(100000, adv_data=payload)

    def send_voltage_and_time(self, voltage, timestamp):
        packed_data = pack('<ff', float(voltage), float(timestamp)) # Ensure float conversion
        for conn_handle in self._connections:
            self._ble.gatts_notify(conn_handle, self._handle, packed_data)

    @staticmethod
    def _advertising_payload(name=None, services=None):
        payload = bytearray()
        # Standard advertising flags
        payload += bytes([0x02, 0x01, 0x06]) # General Discoverable Mode, BR/EDR Not Supported
        if name:
            payload += bytes([len(name) + 1, 0x09]) + name.encode("utf-8") # 0x09: Complete Local Name
        if services:
            # For services, use 0x02 for Incomplete List of 16-bit Service Class UUIDs
            # or 0x03 for Complete List of 16-bit Service Class UUIDs
            # Assuming SERVICE_UUID is a 16-bit UUID
            for uuid in services:
                b = bytes(uuid) # This will be 2 bytes for a 16-bit UUID
                payload += bytes([len(b) + 1, 0x03]) + b # 0x03: Complete list of 16-bit Service UUIDs
        return payload

# ====================== CS1237 驱动 ========================
def cs1237_write_config():
    """
    Writes the configuration to the CS1237 chip.
    Default configuration: 0x1C (0b00011100)
    - PGA Gain: 128
    - Output Rate: 10Hz
    - Channel: Channel 1
    """
    cmd = [1, 1, 0, 0, 1, 0, 1]  # Command to write to configuration register (0x65)
    drdy.init(Pin.OUT) # Temporarily set DRDY/DOUT to output
    sclk.value(0) # Ensure SCLK is low initially
    time.sleep_us(2)

    # Send the write command (0x65)
    for bit_val in cmd:
        sclk.value(1)
        time.sleep_us(2)
        drdy.value(bit_val)
        time.sleep_us(2)
        sclk.value(0)
        time.sleep_us(2)

    # Send the configuration byte (e.g., 0x1C for 10Hz, PGA=128, Channel 1)
    # 00011100: CHS=0 (Channel 1), PGA=011 (Gain 128), RATE=1 (10Hz), DRCTRL=00 (Normal Mode)
    config_byte = 0b00011100
    for i in range(7, -1, -1): # MSB first
        sclk.value(1)
        time.sleep_us(2)
        drdy.value((config_byte >> i) & 0x01)
        time.sleep_us(2)
        sclk.value(0)
        time.sleep_us(2)

    drdy.init(Pin.IN) # Set DRDY/DOUT back to input
    sclk.value(0)     # SCLK should be low when not actively clocking

def cs1237_read_raw():
    """
    Reads a 24-bit raw value from the CS1237.
    Waits for DRDY to go low, then clocks out the data.
    """
    # Wait for DRDY to go low, indicating data is ready
    # Add a timeout to prevent getting stuck if DRDY never goes low
    timeout_start = time.ticks_ms()
    while drdy.value() == 1:
        if time.ticks_diff(time.ticks_ms(), timeout_start) > 500: # 500ms timeout
            print("Error: Timeout waiting for DRDY low")
            return 0 # Or raise an exception
        time.sleep_us(10) # Short pause

    raw_data = 0
    for _ in range(24): # Read 24 bits
        sclk.value(1)
        time.sleep_us(2) # Clock pulse width
        raw_data = (raw_data << 1) | drdy.value()
        sclk.value(0)
        time.sleep_us(2) # Clock pulse width

    # After 24 SCLK pulses, an optional 25th SCLK pulse can be sent
    # to prepare DRDY for the next conversion cycle immediately.
    # This depends on DRCTRL bits in config register.
    # For simplicity, we omit it here, assuming default DRCTRL behavior is fine.

    # The data is in two's complement format.
    # If the 24th bit (MSB) is 1, it's a negative number.
    if (raw_data & 0x800000):
        raw_data -= 0x1000000
    return raw_data

def calculate_voltage(raw_adc_value):
    """
    Calculates voltage from the raw ADC value.
    Voltage = (RawADC * VREF) / (2^23 * PGA_Gain)
    Note: CS1237 output is 24-bit, so full scale is 2^23 for positive range.
    """
    if PGA_GAIN == 0: return 0 # Avoid division by zero
    # Effective full scale is 0x7FFFFF for positive values
    voltage = (raw_adc_value * VREF) / (0x800000 * PGA_GAIN) # Using 0x800000 as effective full scale
    return voltage * 1e6 # Convert to microvolts (μV)

def calibrate_zero_offset():
    """
    Performs a simple zero offset calibration by averaging a few readings.
    """
    sum_raw = 0
    num_readings = 30
    print("Calibrating zero offset...")
    for i in range(num_readings):
        sum_raw += cs1237_read_raw()
        print(f"Calibration reading {i+1}/{num_readings}")
        time.sleep_ms(200) # Wait between readings, ensure it's stable
    offset = sum_raw // num_readings
    print(f"Calibration complete. Offset: {offset}")
    return offset

# =================== 中位数滤波器 ==========================
def median_filter(data_list, window_size=5):
    """Applies a median filter to the data_list."""
    if not data_list: # Handle empty list
        return 0.0
    if len(data_list) < window_size:
        return data_list[-1] # Return the last element if not enough data for full window
    
    # Take the last 'window_size' elements for the filter window
    sorted_window = sorted(data_list[-window_size:])
    # Return the median value
    return sorted_window[window_size // 2]

# ====================== 主程序 ==============================
def main():
    cs1237_write_config() # Configure the CS1237
    time.sleep_ms(500)    # Allow time for CS1237 to stabilize after config
    
    offset = calibrate_zero_offset() # Perform zero offset calibration

    ble = bluetooth.BLE()
    sensor = BLECSV1237Sensor(ble)
    start_time = time.ticks_ms()
    voltage_buffer = []

    # Configuration for data deletion
    # This is the window size defined for the median filter call below
    MEDIAN_FILTER_WINDOW_SIZE = 3
    # Delete data every 180 seconds
    DELETION_INTERVAL_S = 180      
    # Start deletion only after 360 seconds of runtime
    START_DELETION_AFTER_S = 360 
    # Tracks the time of the last deletion, in seconds relative to start_time
    last_deletion_time_s = 0.0     

    print("Starting main loop and BLE advertising...")

    while True:
        raw = cs1237_read_raw() - offset
        voltage_uv = calculate_voltage(raw) # Voltage is now in μV
        
        voltage_buffer.append(voltage_uv)

        current_time_ms = time.ticks_ms()
        # Calculate current time in seconds since start
        current_time_s = time.ticks_diff(current_time_ms, start_time) / 1000.0

        # --- Data Deletion Logic ---
        # Check if it's time to consider deleting data
        if current_time_s >= START_DELETION_AFTER_S:
            # Check if deletion interval has passed since last deletion
            if (current_time_s - last_deletion_time_s) >= DELETION_INTERVAL_S:
                if len(voltage_buffer) > MEDIAN_FILTER_WINDOW_SIZE:
                    # Trim the buffer, keeping only the most recent elements needed for the filter
                    elements_to_keep = MEDIAN_FILTER_WINDOW_SIZE 
                    voltage_buffer = voltage_buffer[-elements_to_keep:]
                    print(f"Log: Trimmed voltage_buffer at {current_time_s:.1f}s. New size: {len(voltage_buffer)}")
                # Update the last deletion time
                last_deletion_time_s = current_time_s
        
        # Apply median filter (using the potentially trimmed buffer)
        filtered_voltage_uv = median_filter(voltage_buffer, window_size=MEDIAN_FILTER_WINDOW_SIZE)

        # Print to console (timestamp in seconds, filtered voltage in μV)
        print(f"Time: {current_time_s:.1f}s, Raw Voltage: {voltage_uv:.3f}μV, Filtered Voltage: {filtered_voltage_uv:.3f}μV")
        
        # Send data via BLE (original voltage and current time in seconds)
        # The characteristic expects voltage (not necessarily μV, depends on what client expects) and time
        # Assuming client expects the same unit as calculate_voltage provides (μV)
        sensor.send_voltage_and_time(voltage_uv, current_time_s) 
        
        time.sleep_ms(200) # Loop interval

if __name__ == "__main__":
    main()
