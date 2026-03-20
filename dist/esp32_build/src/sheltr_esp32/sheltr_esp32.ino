#include <WiFi.h>
#include <WebServer.h>
#include <string.h>
#include "wifi_build_config.h"

#ifndef LED_PIN
#define LED_PIN 2
#endif

static const char* AP_SSID = "Sheltr-ESP32";
static const char* AP_PASS = "sheltr1234";

#ifndef SHELTR_WIFI_SSID
#define SHELTR_WIFI_SSID ""
#endif

#ifndef SHELTR_WIFI_PASS
#define SHELTR_WIFI_PASS ""
#endif

static const char* STA_SSID = SHELTR_WIFI_SSID;
static const char* STA_PASS = SHELTR_WIFI_PASS;

WebServer server(80);
bool led_on = false;
bool wifi_sta_connected = false;

String active_ip() {
  if (wifi_sta_connected) {
    return WiFi.localIP().toString();
  }
  return WiFi.softAPIP().toString();
}

bool connect_sta_wifi() {
  if (strlen(STA_SSID) == 0) {
    return false;
  }

  Serial.print("[Sheltr ESP32] STA connect SSID: ");
  Serial.println(STA_SSID);

  WiFi.mode(WIFI_STA);
  if (strlen(STA_PASS) > 0) {
    WiFi.begin(STA_SSID, STA_PASS);
  } else {
    WiFi.begin(STA_SSID);
  }

  const unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - started) < 20000) {
    delay(250);
  }

  if (WiFi.status() == WL_CONNECTED) {
    wifi_sta_connected = true;
    Serial.print("[Sheltr ESP32] STA IP: ");
    Serial.println(WiFi.localIP());
    return true;
  }

  Serial.println("[Sheltr ESP32] STA connection failed, fallback AP.");
  WiFi.disconnect(true, true);
  return false;
}

void start_fallback_ap() {
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASS);
  wifi_sta_connected = false;
  Serial.print("[Sheltr ESP32] AP SSID: ");
  Serial.println(AP_SSID);
  Serial.print("[Sheltr ESP32] AP IP: ");
  Serial.println(WiFi.softAPIP());
}

void apply_led() {
  digitalWrite(LED_PIN, led_on ? HIGH : LOW);
}

String json_status() {
  String body = "{";
  body += "\"device\":\"Sheltr ESP32\",";
  body += "\"mode\":\"";
  body += wifi_sta_connected ? "sta" : "ap";
  body += "\",";
  body += "\"ssid\":\"";
  body += wifi_sta_connected ? STA_SSID : AP_SSID;
  body += "\",";
  body += "\"ip\":\"";
  body += active_ip();
  body += "\",";
  body += "\"led\":";
  body += led_on ? "true" : "false";
  body += "}";
  return body;
}

void send_status() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "application/json", json_status());
}

void handle_on() {
  led_on = true;
  apply_led();
  send_status();
}

void handle_off() {
  led_on = false;
  apply_led();
  send_status();
}

void handle_toggle() {
  led_on = !led_on;
  apply_led();
  send_status();
}

void setup() {
  pinMode(LED_PIN, OUTPUT);
  apply_led();

  Serial.begin(115200);
  delay(250);
  Serial.println();
  Serial.println("[Sheltr ESP32] boot");

  if (!connect_sta_wifi()) {
    start_fallback_ap();
  }

  server.on("/", HTTP_GET, send_status);
  server.on("/status", HTTP_GET, send_status);
  server.on("/on", HTTP_GET, handle_on);
  server.on("/off", HTTP_GET, handle_off);
  server.on("/toggle", HTTP_GET, handle_toggle);
  server.begin();
}

void loop() {
  server.handleClient();
}
