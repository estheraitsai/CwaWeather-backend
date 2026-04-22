require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// CWA API 設定
const CWA_API_BASE_URL = "https://opendata.cwa.gov.tw/api";
const CWA_API_KEY = process.env.CWA_API_KEY;

// Render / 反向代理環境
app.set("trust proxy", true);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 台灣縣市座標（城市中心點）for IP 自動定位
const CITY_COORDS = [
  { name: "臺北市", lat: 25.04, lng: 121.56 },
  { name: "新北市", lat: 25.01, lng: 121.46 },
  { name: "基隆市", lat: 25.13, lng: 121.74 },
  { name: "桃園市", lat: 24.99, lng: 121.31 },
  { name: "新竹市", lat: 24.81, lng: 120.97 },
  { name: "新竹縣", lat: 24.84, lng: 121.0 },
  { name: "苗栗縣", lat: 24.56, lng: 120.82 },
  { name: "臺中市", lat: 24.15, lng: 120.68 },
  { name: "彰化縣", lat: 24.07, lng: 120.54 },
  { name: "南投縣", lat: 23.91, lng: 120.68 },
  { name: "雲林縣", lat: 23.71, lng: 120.54 },
  { name: "嘉義市", lat: 23.48, lng: 120.44 },
  { name: "嘉義縣", lat: 23.45, lng: 120.25 },
  { name: "臺南市", lat: 22.99, lng: 120.21 },
  { name: "高雄市", lat: 22.63, lng: 120.3 },
  { name: "屏東縣", lat: 22.68, lng: 120.48 },
  { name: "宜蘭縣", lat: 24.76, lng: 121.75 },
  { name: "花蓮縣", lat: 23.99, lng: 121.6 },
  { name: "臺東縣", lat: 22.75, lng: 121.15 },
  { name: "澎湖縣", lat: 23.57, lng: 119.57 },
  { name: "金門縣", lat: 24.44, lng: 118.32 },
  { name: "連江縣", lat: 26.16, lng: 119.95 },
];

// 取得使用者 IP
function getClientIP(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }

  const ip = req.ip || req.connection?.remoteAddress || "";
  return ip.replace("::ffff:", "");
}

// 用 IP 查經緯度
async function getLatLngFromIP(ip) {
  try {
    // 本機開發 / Render 偵錯 / 無法定位時給預設
    if (!ip || ip === "::1" || ip === "127.0.0.1") {
      return { lat: 25.04, lng: 121.56 }; // 台北市
    }

    const res = await axios.get(`https://ipapi.co/${ip}/json/`, {
      timeout: 5000,
    });

    if (!res.data || !res.data.latitude || !res.data.longitude) {
      throw new Error("IP 定位服務未回傳座標");
    }

    return {
      lat: Number(res.data.latitude),
      lng: Number(res.data.longitude),
    };
  } catch (e) {
    console.error("IP 定位失敗，改用台北市為預設:", e.message);
    return { lat: 25.04, lng: 121.56 };
  }
}

// 從經緯度找最近的縣市
function findNearestCity(lat, lng) {
  let bestCity = CITY_COORDS[0];
  let bestDist = Infinity;

  CITY_COORDS.forEach((city) => {
    const dLat = lat - city.lat;
    const dLng = lng - city.lng;
    const dist = dLat * dLat + dLng * dLng;

    if (dist < bestDist) {
      bestDist = dist;
      bestCity = city;
    }
  });

  return bestCity.name;
}

/**
 * 取得指定縣市天氣預報
 * - 如果有 ?locationName=臺北市 → 用指定縣市
 * - 若未指定 locationName → 用使用者 IP 自動推估縣市
 */
async function getWeatherByLocation(req, res) {
  try {
    if (!CWA_API_KEY) {
      return res.status(500).json({
        error: "伺服器設定錯誤",
        message: "尚未設定 CWA_API_KEY",
      });
    }

    let locationName = req.query.locationName;

    if (!locationName) {
      const clientIP = getClientIP(req);
      console.log("🌏 使用者 IP:", clientIP);

      const { lat, lng } = await getLatLngFromIP(clientIP);
      console.log("📡 用戶座標:", lat, lng);

      locationName = findNearestCity(lat, lng);
      console.log("📍 自動偵測縣市:", locationName);
    }

    const response = await axios.get(
      `${CWA_API_BASE_URL}/v1/rest/datastore/F-C0032-001`,
      {
        params: {
          Authorization: CWA_API_KEY,
          locationName,
        },
        timeout: 10000,
      }
    );

    const locationData = response?.data?.records?.location?.[0];

    if (!locationData) {
      return res.status(404).json({
        error: "查無資料",
        message: `無法取得「${locationName}」天氣資料`,
      });
    }

    const weatherData = {
      city: locationData.locationName,
      updateTime: response.data.records.datasetDescription,
      forecasts: [],
    };

    const weatherElements = locationData.weatherElement || [];
    const timeCount = weatherElements[0]?.time?.length || 0;

    for (let i = 0; i < timeCount; i++) {
      const forecast = {
        startTime: weatherElements[0].time[i].startTime,
        endTime: weatherElements[0].time[i].endTime,
        weather: "",
        rain: "",
        minTemp: "",
        maxTemp: "",
        comfort: "",
        windSpeed: "",
      };

      weatherElements.forEach((element) => {
        const value = element?.time?.[i]?.parameter;
        if (!value) return;

        switch (element.elementName) {
          case "Wx":
            forecast.weather = value.parameterName;
            break;
          case "PoP":
            forecast.rain = `${value.parameterName}%`;
            break;
          case "MinT":
            forecast.minTemp = value.parameterName;
            break;
          case "MaxT":
            forecast.maxTemp = value.parameterName;
            break;
          case "CI":
            forecast.comfort = value.parameterName;
            break;
          case "WS":
            forecast.windSpeed = value.parameterName;
            break;
        }
      });

      weatherData.forecasts.push(forecast);
    }

    return res.json({
      success: true,
      data: weatherData,
    });
  } catch (error) {
    console.error("取得天氣資料失敗:", error.message);

    if (error.response) {
      return res.status(error.response.status).json({
        error: "CWA API 錯誤",
        message: error.response.data?.message || "無法取得天氣資料",
        details: error.response.data,
      });
    }

    return res.status(500).json({
      error: "伺服器錯誤",
      message: "無法取得天氣資料，請稍後再試",
    });
  }
}

// Routes
app.get("/", (req, res) => {
  res.json({
    message: "歡迎使用 CWA 天氣預報 API",
    endpoints: {
      weather: "/api/weather?locationName=高雄市（可選）",
      autoDetect: "/api/weather（未帶參數時自動定位）",
      health: "/api/health",
    },
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || "development",
  });
});

app.get("/api/weather", getWeatherByLocation);

app.get("/api/weather/kaohsiung", (req, res) => {
  req.query.locationName = "高雄市";
  return getWeatherByLocation(req, res);
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("未處理錯誤:", err.stack);
  res.status(500).json({
    error: "伺服器錯誤",
    message: err.message || "未知錯誤",
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: "找不到此路徑",
  });
});

app.listen(PORT, () => {
  console.log(`🚀 伺服器已啟動，Port: ${PORT}`);
  console.log(`📍 環境: ${process.env.NODE_ENV || "development"}`);
});