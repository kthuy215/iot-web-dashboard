#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <Adafruit_BMP085.h>
#include <math.h>

// =================================================
// 1. KHAI BAO CHAN
// =================================================
#define LED_PIN 18
#define BUZZER_PIN 19

// =================================================
// 2. WIFI
// =================================================
const char* ssid = "Wokwi-GUEST";
const char* password = "";

// =================================================
// 3. THINGSBOARD CLOUD
// =================================================
const char* mqtt_server = "mqtt.thingsboard.cloud";
const int mqtt_port = 1883;

// Thay bang Access Token moi cua Device ThingsBoard
const char* access_token = "ZR3IEu62AjMjYyGfoJ8r";

const char* telemetry_topic = "v1/devices/me/telemetry";
const char* rpc_request_topic = "v1/devices/me/rpc/request/+";

WiFiClient espClient;
PubSubClient mqttClient(espClient);

// =================================================
// 4. CAM BIEN BMP180
// =================================================
Adafruit_BMP085 bmp;

// =================================================
// 5. CAU TRUC DU LIEU
// =================================================
typedef struct {
  float temperature;
  float pressure;
  float altitude;
} SensorData;

typedef struct {
  float temperature;
  float altitude;
} AlertData;

// =================================================
// 6. QUEUE
// =================================================
QueueHandle_t dataQueue;
QueueHandle_t dataAlert;

// =================================================
// 7. TRANG THAI RPC VA NGO RA
// =================================================
volatile bool rpcLedEnabled = false;
volatile bool rpcBuzzerEnabled = false;

volatile bool ledManualOverride = false;
volatile bool buzzerManualOverride = false;

volatile bool ledActualState = false;
volatile bool buzzerActualState = false;

// =================================================
// 8. HAM DOC PARAMS RPC
// =================================================
bool parseRpcState(String params, bool &state, bool &isAuto) {
  params.trim();
  isAuto = false;

  if (params.startsWith("true")) {
    state = true;
    return true;
  }

  if (params.startsWith("false")) {
    state = false;
    return true;
  }

  params.replace("\"", "");
  params.trim();
  params.toUpperCase();

  if (params.startsWith("ON")) {
    state = true;
    return true;
  }

  if (params.startsWith("OFF") || params.startsWith("STOP")) {
    state = false;
    return true;
  }

  if (params.startsWith("AUTO")) {
    isAuto = true;
    return true;
  }

  return false;
}

// =================================================
// 9. HAM XU LY RPC
// =================================================
void mqttCallback(char* topic, byte* payload, unsigned int length) {

  String message;
  message.reserve(length + 1);

  for (unsigned int i = 0; i < length; i++) {
    message += (char)payload[i];
  }

  Serial.println("\n===== NHAN RPC =====");
  Serial.print("Topic: ");
  Serial.println(topic);
  Serial.print("Payload: ");
  Serial.println(message);

  bool isLedMethod =
      message.indexOf("\"setValue\"") >= 0 ||
      message.indexOf("\"setState\"") >= 0 ||
      message.indexOf("\"setLed\"") >= 0 ||
      message.indexOf("\"getLed\"") >= 0;

  bool isBuzzerMethod =
      message.indexOf("\"setBuzzer\"") >= 0 ||
      message.indexOf("\"getBuzzer\"") >= 0;

  bool validMethod = isLedMethod || isBuzzerMethod;
  bool commandValid = false;

  bool state = false;
  bool isAuto = false;

  int paramsPos = message.indexOf("\"params\"");

  if (paramsPos >= 0) {
    int colonPos = message.indexOf(':', paramsPos);

    if (colonPos >= 0) {
      String params = message.substring(colonPos + 1);
      params.trim();

      commandValid = parseRpcState(params, state, isAuto);
    }
  }

  if (validMethod && commandValid) {

    if (isLedMethod) {

      if (isAuto) {
        ledManualOverride = false;
      } else {
        rpcLedEnabled = state;
        ledManualOverride = true;
      }

      Serial.print("RPC LED: ");
      Serial.println(isAuto ? "AUTO" : (state ? "ON" : "OFF"));
    }

    if (isBuzzerMethod) {

      if (isAuto) {
        buzzerManualOverride = false;
      } else {
        rpcBuzzerEnabled = state;
        buzzerManualOverride = true;
      }

      Serial.print("RPC BUZZER: ");
      Serial.println(isAuto ? "AUTO" : (state ? "ON" : "OFF"));
    }
  }

  else if (!validMethod) {
    Serial.println("Method khong ho tro!");
  }

  else {
    Serial.println("Params khong hop le!");
  }

  // Gui phan hoi RPC
  String requestTopic = String(topic);
  int lastSlash = requestTopic.lastIndexOf('/');

  if (lastSlash >= 0) {

    String requestId = requestTopic.substring(lastSlash + 1);

    String responseTopic =
        "v1/devices/me/rpc/response/" + requestId;

    String response =
        String("{\"success\":") +
        ((commandValid && validMethod) ? "true" : "false") +
        ",\"ledCommand\":" + (rpcLedEnabled ? "true" : "false") +
        ",\"buzzerCommand\":" + (rpcBuzzerEnabled ? "true" : "false") +
        "}";

    mqttClient.publish(
        responseTopic.c_str(),
        response.c_str()
    );
  }
}

// =================================================
// TASK 1: DOC DU LIEU CAM BIEN
// CORE 1
// =================================================
void Task_ReadData(void *pvParameters) {

  SensorData sensor;
  AlertData alert;

  while (1) {

    sensor.temperature = bmp.readTemperature();
    sensor.pressure = bmp.readPressure();
    sensor.altitude = bmp.readAltitude(101325);

    alert.temperature = sensor.temperature;
    alert.altitude = sensor.altitude;

    Serial.println("\n===== DU LIEU BMP180 =====");

    Serial.print("Nhiet do: ");
    Serial.print(sensor.temperature);
    Serial.println(" *C");

    Serial.print("Ap suat: ");
    Serial.print(sensor.pressure / 100.0);
    Serial.println(" hPa");

    Serial.print("Do cao: ");
    Serial.print(sensor.altitude);
    Serial.println(" m");

    Serial.print("Task_ReadData - Core: ");
    Serial.println(xPortGetCoreID());

    // Gui du lieu vao dataQueue
    if (xQueueSend(dataQueue, &sensor, 0) != pdTRUE) {

      SensorData oldData;

      xQueueReceive(dataQueue, &oldData, 0);
      xQueueSend(dataQueue, &sensor, 0);

      Serial.println("dataQueue day - da thay mau cu bang mau moi!");
    }

    // Gui du lieu canh bao
    xQueueOverwrite(dataAlert, &alert);

    vTaskDelay(pdMS_TO_TICKS(2000));
  }
}

// =================================================
// TASK 2: XU LY CANH BAO
// CORE 1
// =================================================
void Task_Alert(void *pvParameters) {

  AlertData alert;

  float previousAltitude = 0;

  bool firstReading = true;
  bool alertActive = false;
  bool previousAlertActive = false;

  while (1) {

    if (xQueueReceive(dataAlert, &alert,
                      pdMS_TO_TICKS(100)) == pdTRUE) {

      bool temperatureAlert =
          (alert.temperature > 35.0 ||
           alert.temperature < 15.0);

      bool altitudeAlert = false;

      if (!firstReading) {

        float altitudeChange =
            fabs(alert.altitude - previousAltitude);

        if (altitudeChange >= 5.0) {

          altitudeAlert = true;

          Serial.println(
              "CANH BAO: Do cao thay doi dot ngot!");
        }
      }

      previousAltitude = alert.altitude;
      firstReading = false;

      alertActive = temperatureAlert || altitudeAlert;

      if (alertActive) {
        Serial.println("CANH BAO TU DONG!");
      }

      // Khi trang thai canh bao thay doi,
      // dua cac thiet bi ve che do tu dong.
      if (alertActive != previousAlertActive) {

        ledManualOverride = false;
        buzzerManualOverride = false;

        previousAlertActive = alertActive;
      }
    }

    // Uu tien lenh dieu khien RPC neu co
    bool ledState =
        ledManualOverride ? rpcLedEnabled : alertActive;

    bool buzzerState =
        buzzerManualOverride ? rpcBuzzerEnabled : alertActive;

    digitalWrite(LED_PIN, ledState ? HIGH : LOW);

    if (buzzerState) {
      tone(BUZZER_PIN, 2000);
    } else {
      noTone(BUZZER_PIN);
    }

    ledActualState = ledState;
    buzzerActualState = buzzerState;

    vTaskDelay(pdMS_TO_TICKS(20));
  }
}

// =================================================
// TASK 3: GUI DU LIEU LEN THINGSBOARD
// CORE 0
// =================================================
void Task_TransmitData(void *pvParameters) {

  SensorData sensor;
  char payload[256];

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);

  Serial.println("Dang ket noi WiFi...");

  while (WiFi.status() != WL_CONNECTED) {

    Serial.println("Dang cho WiFi...");

    vTaskDelay(pdMS_TO_TICKS(1000));
  }

  Serial.println("WiFi connected!");

  Serial.print("IP: ");
  Serial.println(WiFi.localIP());

  mqttClient.setServer(mqtt_server, mqtt_port);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setKeepAlive(60);
  mqttClient.setBufferSize(512);

  while (1) {

    // Kiem tra WiFi
    if (WiFi.status() != WL_CONNECTED) {

      Serial.println("WiFi mat ket noi!");

      WiFi.reconnect();

      vTaskDelay(pdMS_TO_TICKS(1000));
      continue;
    }

    // Ket noi ThingsBoard MQTT
    if (!mqttClient.connected()) {

      Serial.println("Dang ket noi ThingsBoard...");

      String clientId = "ESP32-FreeRTOS-Lab3";

      if (mqttClient.connect(
              clientId.c_str(),
              access_token,
              NULL)) {

        Serial.println("ThingsBoard connected!");

        // Dang ky nhan RPC
        if (mqttClient.subscribe(rpc_request_topic)) {
          Serial.println("Da dang ky nhan RPC!");
        } else {
          Serial.println("Dang ky RPC that bai!");
        }
      }

      else {

        Serial.print("MQTT connection failed, state = ");
        Serial.println(mqttClient.state());

        vTaskDelay(pdMS_TO_TICKS(2000));
        continue;
      }
    }

    // Duy tri MQTT va nhan RPC
    mqttClient.loop();

    // Nhan du lieu tu Queue
    if (xQueueReceive(dataQueue, &sensor,
                      pdMS_TO_TICKS(100)) == pdTRUE) {

      bool ledState = ledActualState;
      bool buzzerState = buzzerActualState;

      snprintf(payload, sizeof(payload),
               "{\"temperature\":%.2f,"
               "\"pressure\":%.2f,"
               "\"altitude\":%.2f,"
               "\"led\":%s,"
               "\"buzzer\":%s}",
               sensor.temperature,
               sensor.pressure / 100.0,
               sensor.altitude,
               ledState ? "true" : "false",
               buzzerState ? "true" : "false");

      // Gui Telemetry len ThingsBoard
      if (mqttClient.publish(telemetry_topic, payload)) {

        Serial.print("Da gui ThingsBoard: ");
        Serial.println(payload);

      } else {

        Serial.println("Gui Telemetry that bai!");
      }
    }

    mqttClient.loop();

    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

// =================================================
// SETUP
// =================================================
void setup() {

  Serial.begin(115200);

  pinMode(LED_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);

  digitalWrite(LED_PIN, LOW);
  noTone(BUZZER_PIN);

  Wire.begin(21, 22);

  // Khoi tao BMP180
  if (!bmp.begin()) {

    Serial.println("Khong tim thay BMP180!");

    while (1) {
      delay(1000);
    }
  }

  Serial.println("BMP180 ket noi thanh cong!");

  // Tao Queue
  dataQueue = xQueueCreate(5, sizeof(SensorData));
  dataAlert = xQueueCreate(1, sizeof(AlertData));

  if (dataQueue == NULL || dataAlert == NULL) {

    Serial.println("Loi tao Queue!");

    while (1) {
      delay(1000);
    }
  }

  Serial.println("Tao Queue thanh cong!");

  // Task doc cam bien - Core 1
  xTaskCreatePinnedToCore(
      Task_ReadData,
      "Task_ReadData",
      4096,
      NULL,
      2,
      NULL,
      1
  );

  // Task canh bao - Core 1
  xTaskCreatePinnedToCore(
      Task_Alert,
      "Task_Alert",
      4096,
      NULL,
      3,
      NULL,
      1
  );

  // Task gui du lieu - Core 0
  xTaskCreatePinnedToCore(
      Task_TransmitData,
      "Task_TransmitData",
      6144,
      NULL,
      1,
      NULL,
      0
  );
}

// =================================================
// LOOP
// =================================================
void loop() {
  vTaskDelay(pdMS_TO_TICKS(1000));
}
