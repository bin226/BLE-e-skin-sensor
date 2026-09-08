// Get global app instance
const app = getApp();

// Find element in array by key-value, return index
function inArray(arr, key, val) {
    for (let i = 0; i < arr.length; i++) {
        if (arr[i][key] === val) {
            return i;
        }
    }
    return -1;
}

// Convert ArrayBuffer to floats
function ab2floats(buffer) {
    const dataView = new DataView(buffer);
    // Read 4-byte floats in little-endian
    const voltage = dataView.getFloat32(0, true); 
    const timestamp = dataView.getFloat32(4, true);
    return { voltage, timestamp };
}

// Configuration parameters
const MAX_DATA_POINTS = 250; // Maximum data points to display on chart
const WINDOW_SECONDS = 3.6; // Sliding window seconds for average calculation
const SAMPLING_INTERVAL_S = 0.2; // Sampling interval (seconds)
const THRESHOLD_RISE = 140.0; // Voltage threshold for rising event
const THRESHOLD_FALL = 50.0; // Voltage threshold for falling event
const MIN_DURATION_S = 0.6; // Minimum event duration (seconds)
const SUPPRESS_RATIO_RISE = 0.67; // Suppression ratio after rising event
const SUPPRESS_RATIO_FALL = 0.33; // Suppression ratio after falling event
const SUPPRESS_TIMEOUT_S = 6.0; // Suppression state timeout (seconds)
const CROSS_VALIDATION_MARGIN_RISE = 45.0; // Cross-validation rising margin
const CROSS_VALIDATION_MARGIN_FALL = 35.0; // Cross-validation falling margin
const SETTLE_TIME_S = 1.25; // Time to wait for voltage to settle after event before detecting opposite event
const MIN_DV_DT = 20.0; // Minimum voltage change rate (μV/s) to detect as event
const BINARY_TO_LETTER_MAP = { // Binary to letter mapping
    "00000": "A", "00001": "B", "00010": "C", "00011": "D",
    "00100": "E", "00101": "F", "00110": "G", "00111": "H",
    "01000": "I", "01001": "J", "01010": "K", "01011": "L",
    "01100": "M", "01101": "N", "01110": "O", "01111": "P",
    "10000": "Q", "10001": "R", "10010": "S", "10011": "T",
    "10100": "U", "10101": "V", "10110": "W", "10111": "X",
    "11000": "Y", "11001": "Z", "11111": " "
};
const MAX_HIST_BIN_DISPLAY = 250; // Maximum binary history length in status info
const MEDIAN_FILTER_WINDOW = 5; // Median filter window size
const UI_UPDATE_INTERVAL = 200; // UI update interval (milliseconds)
const VOLTAGE_CHANGE_THRESHOLD_UV = 1000; // Maximum allowed voltage change (±1000μV = ±1mV)
const VOLTAGE_REFERENCE_WINDOW_S = 10; // Reference window for mean calculation (seconds)
const VOLTAGE_REFERENCE_WINDOW_SIZE = Math.floor(VOLTAGE_REFERENCE_WINDOW_S / SAMPLING_INTERVAL_S); // Reference window size in samples

// Global state variables
let times = []; // Timestamp array
let voltages = []; // Voltage value array
let current_v = 0.0; // Current voltage
let current_t = 0.0; // Current timestamp
let voltage_window_size = Math.floor(WINDOW_SECONDS / SAMPLING_INTERVAL_S); // Voltage sliding window size
let voltage_window = []; // Voltage sliding window
let current_state = null; // Current event state (null, 'rising', 'falling')
let event_start_time = 0.0; // Event start time
let last_output = null; // Last output (0 or 1)
let last_peak_value = null; // Last peak value
let last_reference_avg = null; // Last reference average
let suppress_event = false; // Whether in suppression state
let suppress_event_trigger_time = 0.0; // Suppression event trigger time
let baseline_voltage = null; // Stable baseline voltage before last event
let is_settling = false; // Whether voltage is settling after an event
let settle_start_time = 0.0; // Start time of settling period
let last_voltage_for_rate = null; // Last voltage for rate calculation
let last_timestamp_for_rate = null; // Last timestamp for rate calculation
let historical_binary_outputs = ""; // Historical binary output string
let converted_letters = ""; // Converted letter string
let processed_binary_idx = 0; // Processed binary index
let voltageBuffer = []; // Voltage buffer for median filter
let offScreenCanvas = null; // Off-screen canvas
let needRedraw = true; // Whether to redraw chart
let lastUiUpdateTime = 0; // Last UI update time
let firstTimestamp = null; // First timestamp

// Throttle function to limit function call frequency
function throttle(func, limit) {
    let lastFunc;
    let lastRan;
    return function() {
        const context = this;
        const args = arguments;
        if (!lastRan) {
            func.apply(context, args);
            lastRan = Date.now();
        } else {
            clearTimeout(lastFunc);
            lastFunc = setTimeout(function() {
                if ((Date.now() - lastRan) >= limit) {
                    func.apply(context, args);
                    lastRan = Date.now();
                }
            }, limit - (Date.now() - lastRan));
        }
    }
}

// Median filter to smooth voltage data
function medianFilter(newValue) {
    voltageBuffer.push(newValue);
    if (voltageBuffer.length > MEDIAN_FILTER_WINDOW) {
        voltageBuffer.shift(); // Maintain buffer size
    }
    if (voltageBuffer.length < 3) {
        return newValue; // Return original value if insufficient data
    }
    const sorted = [...voltageBuffer].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    // If window size is odd, return middle value; if even, return average of two middle values
    return sorted.length % 2 !== 0 
        ? sorted[mid] 
        : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Calculate dynamic threshold deviation
function calculate_dynamic_threshold_deviation(last_peak, last_avg) {
    if (last_peak === null || last_avg === null) {
        return Infinity;
    }
    return Math.abs(last_peak - last_avg);
}

// Outlier filter to remove abnormal voltage spikes
// Voltage change should be within ±1mV (±1000μV) relative to the mean of last 10s
function outlierFilter(newVoltage, currentTimestamp) {
    // If we don't have enough data, use the new voltage directly
    if (voltages.length < VOLTAGE_REFERENCE_WINDOW_SIZE) {
        return { valid: true, value: newVoltage };
    }
    
    // Calculate mean of the last 10 seconds (reference window)
    let referenceStartIdx = Math.max(0, voltages.length - VOLTAGE_REFERENCE_WINDOW_SIZE);
    let referenceVoltages = voltages.slice(referenceStartIdx);
    let referenceMean = referenceVoltages.reduce((sum, v) => sum + v, 0) / referenceVoltages.length;
    
    // Calculate voltage change from reference mean
    let voltageChange = Math.abs(newVoltage - referenceMean);
    
    // Check if voltage change is within threshold
    if (voltageChange > VOLTAGE_CHANGE_THRESHOLD_UV) {
        console.log(`Outlier detected: voltage change ${voltageChange.toFixed(1)}μV exceeds threshold ${VOLTAGE_CHANGE_THRESHOLD_UV}μV, using previous value`);
        // Return the last valid voltage value
        return { 
            valid: false, 
            value: voltages[voltages.length - 1] // Use last valid value
        };
    }
    
    return { valid: true, value: newVoltage };
}

// Core event detection logic
function check_event_logic(current_voltage_val, timestamp_val) {
    if (suppress_event && (timestamp_val - suppress_event_trigger_time > SUPPRESS_TIMEOUT_S)) {
        console.log(`Info: suppress_event automatically reset after timeout at ${timestamp_val.toFixed(1)}s`);
        suppress_event = false;
        current_state = null;
    }

    if (is_settling && (timestamp_val - settle_start_time > SETTLE_TIME_S)) {
        is_settling = false;
        console.log(`Info: Voltage settled, baseline updated at ${timestamp_val.toFixed(1)}s`);
    }

    let min_required_points_for_logic = Math.max(Math.floor(voltage_window_size / 3), 5);
    if (voltage_window.length < min_required_points_for_logic && voltage_window_size > 0) {
        return null;
    }

    let current_avg_logic = voltage_window.reduce((sum, val) => sum + val, 0) / voltage_window.length;
    
    if (!suppress_event && !is_settling && current_state === null) {
        if (baseline_voltage === null) {
            baseline_voltage = current_avg_logic;
        } else {
            baseline_voltage = baseline_voltage * 0.99 + current_avg_logic * 0.01;
        }
    }

    let reference_for_delta = (baseline_voltage !== null && !suppress_event) ? baseline_voltage : current_avg_logic;
    let delta = current_voltage_val - reference_for_delta;

    if (suppress_event) {
        if (last_reference_avg !== null && last_peak_value !== null) {
            let dynamic_deviation = calculate_dynamic_threshold_deviation(last_peak_value, last_reference_avg);
            if (last_output === 1) {
                let release_threshold = baseline_voltage !== null 
                    ? baseline_voltage + dynamic_deviation * 0.3 
                    : last_reference_avg + dynamic_deviation * (1 - SUPPRESS_RATIO_RISE);
                if (current_voltage_val <= release_threshold) {
                    suppress_event = false;
                    is_settling = true;
                    settle_start_time = timestamp_val;
                    console.log(`Info: Suppression released after rising event at ${timestamp_val.toFixed(1)}s`);
                }
            } else if (last_output === 0) {
                let release_threshold = baseline_voltage !== null 
                    ? baseline_voltage - dynamic_deviation * 0.3 
                    : last_reference_avg - dynamic_deviation * (1 - SUPPRESS_RATIO_FALL);
                if (current_voltage_val >= release_threshold) {
                    suppress_event = false;
                    is_settling = true;
                    settle_start_time = timestamp_val;
                    console.log(`Info: Suppression released after falling event at ${timestamp_val.toFixed(1)}s`);
                }
            }
        }
        if (suppress_event) {
            return null;
        }
    }

    if (is_settling) {
        if (current_state !== null) {
            if ((current_state === 'rising' && last_output === 1) || 
                (current_state === 'falling' && last_output === 0)) {
            } else {
                return null;
            }
        } else {
            return null;
        }
    }

    let detected_event_output = null;
    
    // Calculate voltage change rate (dv/dt)
    let dv_dt = 0;
    if (last_voltage_for_rate !== null && last_timestamp_for_rate !== null && timestamp_val > last_timestamp_for_rate) {
        dv_dt = (current_voltage_val - last_voltage_for_rate) / (timestamp_val - last_timestamp_for_rate);
    }
    last_voltage_for_rate = current_voltage_val;
    last_timestamp_for_rate = timestamp_val;
    
    if (current_state === null && !suppress_event && !is_settling) {
        let can_detect_rise = delta >= THRESHOLD_RISE && dv_dt >= MIN_DV_DT;
        let can_detect_fall = delta <= -THRESHOLD_FALL && dv_dt <= -MIN_DV_DT;
        
        // For falling event, also require voltage to be below baseline significantly
        if (baseline_voltage !== null) {
            can_detect_fall = can_detect_fall && current_voltage_val < baseline_voltage - THRESHOLD_FALL * 0.3;
        }
        
        if (can_detect_rise) {
            current_state = 'rising';
            event_start_time = timestamp_val;
            console.log(`Entering rising state: delta=${delta.toFixed(1)}, dv_dt=${dv_dt.toFixed(1)}μV/s`);
        } else if (can_detect_fall) {
            current_state = 'falling';
            event_start_time = timestamp_val;
            console.log(`Entering falling state: delta=${delta.toFixed(1)}, dv_dt=${dv_dt.toFixed(1)}μV/s`);
        } else if (delta <= -THRESHOLD_FALL && baseline_voltage === null) {
            // Fallback for initial state without baseline
            current_state = 'falling';
            event_start_time = timestamp_val;
        }
    } else if (current_state !== null) {
        let duration = timestamp_val - event_start_time;
        let is_event_condition_met = false;
        let potential_output = null;

        if (current_state === 'rising') {
            // Require both threshold crossing AND positive rate for valid rising event
            if (delta >= THRESHOLD_RISE && dv_dt >= MIN_DV_DT * 0.5) {
                is_event_condition_met = true;
                potential_output = 1;
            } else {
                current_state = null;
            }
        } else if (current_state === 'falling') {
            // Require both threshold crossing AND negative rate for valid falling event
            if (delta <= -THRESHOLD_FALL && dv_dt <= -MIN_DV_DT * 0.5) {
                is_event_condition_met = true;
                potential_output = 0;
            } else {
                current_state = null;
            }
        }

        if (is_event_condition_met && duration >= MIN_DURATION_S) {
            let can_trigger_this_event = true;
            
            if (last_output !== null && baseline_voltage !== null) {
                if (potential_output !== last_output) {
                    if (potential_output === 1) {
                        if (current_voltage_val < baseline_voltage + CROSS_VALIDATION_MARGIN_RISE) {
                            can_trigger_this_event = false;
                            console.log(`Debug: Rejected rising - voltage ${current_voltage_val.toFixed(1)} not above baseline ${baseline_voltage.toFixed(1)}`);
                        }
                    } else if (potential_output === 0) {
                        if (last_peak_value !== null) {
                            if (current_voltage_val > baseline_voltage - CROSS_VALIDATION_MARGIN_FALL) {
                                can_trigger_this_event = false;
                                console.log(`Debug: Rejected falling - voltage ${current_voltage_val.toFixed(1)} not below baseline ${baseline_voltage.toFixed(1)}`);
                            }
                        }
                    }
                }
            }

            if (can_trigger_this_event) {
                last_peak_value = current_voltage_val;
                last_reference_avg = current_avg_logic;
                last_output = potential_output;
                suppress_event = true;
                suppress_event_trigger_time = timestamp_val;
                detected_event_output = potential_output;
                current_state = null;
                console.log(`Event: ${potential_output} at ${timestamp_val.toFixed(1)}s, voltage: ${current_voltage_val.toFixed(1)}μV, baseline: ${baseline_voltage ? baseline_voltage.toFixed(1) : 'N/A'}μV`);
            } else {
                current_state = null;
            }
        }
    }

    return detected_event_output;
}

// Convert binary string to letters
function binary_to_letter_conversion() {
    let new_letters_converted = "";
    // Convert every 5 binary bits to one letter
    while (historical_binary_outputs.length >= processed_binary_idx + 5) {
        let chunk = historical_binary_outputs.slice(processed_binary_idx, processed_binary_idx + 5);
        let letter = BINARY_TO_LETTER_MAP[chunk] || '?'; // Use '?' if mapping not found
        converted_letters += letter;
        new_letters_converted += letter;
        processed_binary_idx += 5;
    }
    if (new_letters_converted) {
        console.log(`Info: Converted new letters: ${new_letters_converted}`);
        return new_letters_converted;
    }
    return '';
}

// Create off-screen Canvas for background chart rendering to improve performance
function createOffScreenCanvas() {
    offScreenCanvas = wx.createOffscreenCanvas({
        type: '2d',
        width: 280,
        height: 240
    });
}

// Async chart drawing
async function drawChart(canvasId) {
    if (!needRedraw) return;

    const query = wx.createSelectorQuery();
    query.select(`#${canvasId}`)
        .fields({ node: true, size: true })
        .exec(async (res) => {
            if (!res[0]) return;
            
            const canvasNode = res[0].node;
            const canvasWidth = res[0].width;
            const canvasHeight = res[0].height;
            const ctx = canvasNode.getContext('2d');

            const dpr = wx.getSystemInfoSync().pixelRatio;
            canvasNode.width = canvasWidth * dpr;
            canvasNode.height = canvasHeight * dpr;
            ctx.scale(dpr, dpr);
            ctx.clearRect(0, 0, canvasWidth, canvasHeight);

            if (times.length === 0) return;

            const minTime = Math.min(...times);
            const maxTime = Math.max(...times);
            const minVoltage = Math.min(...voltages);
            const maxVoltage = Math.max(...voltages);
            const voltageRange = Math.max(500, maxVoltage - minVoltage);
            const voltageMedian = (minVoltage + maxVoltage) / 2;
            const displayMinVoltage = voltageMedian - voltageRange / 2;
            const displayMaxVoltage = voltageMedian + voltageRange / 2;
            const timeRange = maxTime - minTime;
            const padding = { top: 8, right: 12, bottom: 8, left: 12 };
            const xScale = (canvasWidth - padding.left - padding.right) / timeRange;
            const yScale = (canvasHeight - padding.top - padding.bottom) / voltageRange;

            // Draw subtle background gradient
            const bgGradient = ctx.createLinearGradient(0, 0, 0, canvasHeight);
            bgGradient.addColorStop(0, '#fafafa');
            bgGradient.addColorStop(1, '#f0f0f0');
            ctx.fillStyle = bgGradient;
            ctx.fillRect(0, 0, canvasWidth, canvasHeight);

            // Draw Y-axis grid lines (dashed)
            ctx.strokeStyle = '#d9d9d9';
            ctx.lineWidth = 0.5;
            ctx.setLineDash([3, 3]);
            const yStep = Math.max(100, Math.ceil(voltageRange / 4));
            for (let v = displayMinVoltage; v <= displayMaxVoltage; v += yStep) {
                const y = canvasHeight - padding.bottom - (v - displayMinVoltage) * yScale;
                ctx.beginPath();
                ctx.moveTo(padding.left, y);
                ctx.lineTo(canvasWidth - padding.right, y);
                ctx.stroke();
            }

            // Draw X-axis grid lines (dashed)
            const xStep = Math.max(1, Math.ceil(timeRange / 5));
            for (let t = minTime; t <= maxTime; t += xStep) {
                const x = padding.left + (t - minTime) * xScale;
                ctx.beginPath();
                ctx.moveTo(x, padding.top);
                ctx.lineTo(x, canvasHeight - padding.bottom);
                ctx.stroke();
            }
            ctx.setLineDash([]);

            // Draw line chart with gradient fill
            if (times.length > 1) {
                // Create gradient for area fill
                const gradient = ctx.createLinearGradient(0, padding.top, 0, canvasHeight - padding.bottom);
                gradient.addColorStop(0, 'rgba(99, 102, 241, 0.25)');
                gradient.addColorStop(1, 'rgba(99, 102, 241, 0.03)');
                
                // Draw filled area
                ctx.beginPath();
                const firstX = padding.left + (times[0] - minTime) * xScale;
                const firstY = canvasHeight - padding.bottom - (voltages[0] - displayMinVoltage) * yScale;
                ctx.moveTo(firstX, canvasHeight - padding.bottom);
                ctx.lineTo(firstX, firstY);
                
                for (let i = 1; i < times.length; i++) {
                    const x = padding.left + (times[i] - minTime) * xScale;
                    const y = canvasHeight - padding.bottom - (voltages[i] - displayMinVoltage) * yScale;
                    ctx.lineTo(x, y);
                }
                
                const lastX = padding.left + (times[times.length - 1] - minTime) * xScale;
                ctx.lineTo(lastX, canvasHeight - padding.bottom);
                ctx.closePath();
                ctx.fillStyle = gradient;
                ctx.fill();

                // Draw line with shadow
                ctx.shadowColor = 'rgba(99, 102, 241, 0.4)';
                ctx.shadowBlur = 4;
                ctx.shadowOffsetY = 1;
                
                ctx.beginPath();
                ctx.strokeStyle = '#6366f1';
                ctx.lineWidth = 2;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.moveTo(firstX, firstY);
                
                for (let i = 1; i < times.length; i++) {
                    const x = padding.left + (times[i] - minTime) * xScale;
                    const y = canvasHeight - padding.bottom - (voltages[i] - displayMinVoltage) * yScale;
                    ctx.lineTo(x, y);
                }
                ctx.stroke();
                
                ctx.shadowColor = 'transparent';
            }

            // Mark current latest data point with glow
            if (times.length > 0) {
                const lastX = padding.left + (times[times.length - 1] - minTime) * xScale;
                const lastY = canvasHeight - padding.bottom - (voltages[voltages.length - 1] - displayMinVoltage) * yScale;

                // Outer glow
                ctx.shadowColor = 'rgba(251, 146, 60, 0.6)';
                ctx.shadowBlur = 8;
                ctx.fillStyle = '#f97316';
                ctx.beginPath();
                ctx.arc(lastX, lastY, 7, 0, Math.PI * 2);
                ctx.fill();
                
                // Inner dot
                ctx.shadowBlur = 0;
                ctx.fillStyle = '#fff';
                ctx.beginPath();
                ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
                ctx.fill();
            }

            needRedraw = false;
        });
}

// Throttled UI update function
const throttledUIUpdate = throttle(function(page) {
    const now = Date.now();
    if (now - lastUiUpdateTime < UI_UPDATE_INTERVAL) return; // Frequency limit
    lastUiUpdateTime = now;
    drawChart('voltageChart'); // Call drawing function

    // Prepare status information to display
    let display_binary_history = historical_binary_outputs;
    let actualBinLength = historical_binary_outputs.length;
    let displayBinLength = Math.min(actualBinLength, MAX_HIST_BIN_DISPLAY);
    
    // Truncate display if history is too long
    if (actualBinLength > MAX_HIST_BIN_DISPLAY) {
        display_binary_history = "..." + historical_binary_outputs.slice(-MAX_HIST_BIN_DISPLAY);
    }
    
    let status_info_lines = [
        `Time: ${current_t.toFixed(1)}s`,
        `Voltage: ${current_v.toFixed(1)}μV`,
        `Event State: ${current_state || 'None'}`,
        `Last Output: ${last_output !== null ? last_output : 'None'}`,
        `Suppressed: ${suppress_event ? 'Yes' : 'No'}`,
        "----------------------------------",
        `Binary History (${displayBinLength}/${actualBinLength} bits):`,
        `${display_binary_history}`,
        `Text Output:`,
        `${converted_letters}`
    ];
    
    // Display suppression time if in suppression state
    if (suppress_event) {
        let time_in_suppress = Math.max(0, current_t - suppress_event_trigger_time);
        status_info_lines.splice(5, 0, `Suppress Time: ${time_in_suppress.toFixed(1)}s`);
    }
    
    // Update page data
    let timeInSuppress = null;
    if (suppress_event) {
        timeInSuppress = Math.max(0, current_t - suppress_event_trigger_time);
    }
    
    page.setData({
        currentTime: `${current_t.toFixed(1)}s`,
        currentVoltage: `${current_v.toFixed(1)}μV`,
        eventState: current_state || 'None',
        lastOutput: last_output !== null ? last_output : 'None',
        isSuppressed: suppress_event,
        isSuppressedText: suppress_event ? 'Yes' : 'No',
        suppressTime: timeInSuppress !== null ? `${timeInSuppress.toFixed(1)}s` : '',
        binaryLength: actualBinLength,
        binaryDisplay: display_binary_history,
        textOutput: converted_letters || 'Waiting for input...'
    });
}, UI_UPDATE_INTERVAL);

Page({
    data: {
        deviceId: '',
        name: '',
        rssi: '',
        services: [],
        characteristics: [],
        currentTime: '0.0s',
        currentVoltage: '0.0μV',
        eventState: 'None',
        lastOutput: 'None',
        isSuppressed: false,
        isSuppressedText: 'No',
        suppressTime: '',
        binaryLength: 0,
        binaryDisplay: '',
        textOutput: 'Waiting for input...',
        chartSize: {
            width: 280,
            height: 240
        }
    },
    // When page loads
    onLoad(options) {
        this.setData({
            deviceId: options.deviceId,
            name: options.name,
            rssi: options.rssi
        });
        
        createOffScreenCanvas(); // Create off-screen Canvas
        this.connectDevice(); // Connect BLE device
    },
    // Connect BLE device
    connectDevice() {
        wx.createBLEConnection({
            deviceId: this.data.deviceId,
            success: (res) => {
                console.log('BLE connection success', res);
                this.getDeviceServices(); // Get services
            },
            fail: (res) => {
                console.error('BLE connection failed', res);
                this.setData({
                    statusInfo: 'Connection failed: ' + res.errMsg
                });
            }
        });
    },
    // Get BLE device services
    getDeviceServices() {
        wx.getBLEDeviceServices({
            deviceId: this.data.deviceId,
            success: (res) => {
                console.log('Get services success', res);
                const serviceId = '0000181A-0000-1000-8000-00805F9B34FB'; // Target service UUID
                const targetService = res.services.find(service => service.uuid === serviceId);
                if (targetService) {
                    this.setData({
                        services: [targetService]
                    });
                    this.getDeviceCharacteristics(targetService.uuid); // Get characteristics
                } else {
                    console.log('Target service not found');
                    this.setData({
                        statusInfo: 'Error: Target service (0x181A) not found'
                    });
                }
            },
            fail: (res) => {
                console.error('Get services failed', res);
                this.setData({
                    statusInfo: 'Get services failed: ' + res.errMsg
                });
            }
        });
    },
    // Get service characteristics
    getDeviceCharacteristics(serviceId) {
        wx.getBLEDeviceCharacteristics({
            deviceId: this.data.deviceId,
            serviceId: serviceId,
            success: (res) => {
                console.log('Get characteristics success', res);
                this.setData({
                    characteristics: res.characteristics
                });
                // Iterate through characteristics, find and enable notify
                res.characteristics.forEach(characteristic => {
                    if (characteristic.properties.notify) {
                        this.notifyCharacteristicChange(serviceId, characteristic.uuid);
                    }
                });
            },
            fail: (res) => {
                console.error('Get characteristics failed', res);
                this.setData({
                    statusInfo: 'Get characteristics failed: ' + res.errMsg
                });
            }
        });
    },
    // Enable characteristic value change notification
    notifyCharacteristicChange(serviceId, characteristicId) {
        wx.notifyBLECharacteristicValueChange({
            state: true, // Enable
            deviceId: this.data.deviceId,
            serviceId: serviceId,
            characteristicId: characteristicId,
            success: (res) => {
                console.log('Enable notification success', res);
                // Listen to characteristic value change events
                wx.onBLECharacteristicValueChange((res) => {
                    // Parse received data
                    let { voltage, timestamp } = ab2floats(res.value);
                    
                    if (firstTimestamp === null) {
                        firstTimestamp = timestamp; // Record first timestamp
                    }
                    
                    const filteredVoltage = medianFilter(voltage); // Apply median filter to voltage
                    
                    // Apply outlier filter to remove abnormal voltage spikes
                    const outlierResult = outlierFilter(filteredVoltage, timestamp);
                    const finalVoltage = outlierResult.value;
                    
                    current_v = finalVoltage;
                    current_t = timestamp;

                    // Maintain chart data array, keep fixed length
                    if (times.length >= MAX_DATA_POINTS) {
                        times.shift();
                        voltages.shift();
                    }
                    times.push(timestamp);
                    voltages.push(finalVoltage);

                    // Maintain voltage sliding window
                    if (voltage_window.length >= voltage_window_size) {
                        voltage_window.shift();
                    }
                    voltage_window.push(filteredVoltage);

                    // Run event detection logic
                    let event_output = check_event_logic(current_v, current_t);
                    if (event_output !== null) {
                        console.log(`Event detected --- Time: ${current_t.toFixed(1)}s, Output: ${event_output}, Voltage: ${current_v.toFixed(3)}μV`);
                        historical_binary_outputs += event_output.toString();
                        const newLetters = binary_to_letter_conversion(); // Attempt binary to letter conversion
                        
                        if (newLetters) {
                            throttledUIUpdate(this); // Immediately update UI if new letters generated
                        }
                    }
                    
                    needRedraw = true; // Mark chart for redraw
                    
                    throttledUIUpdate(this); // Call throttled UI update function
                });
            },
            fail: (res) => {
                console.error('Enable notification failed', res);
                this.setData({
                    statusInfo: 'Enable notification failed: ' + res.errMsg
                });
            }
        });
    },
    // When page unloads
    onUnload() {
        // Close BLE connection
        wx.closeBLEConnection({
            deviceId: this.data.deviceId
        });
    }
});
