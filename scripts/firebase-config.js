// scripts/firebase-config.js
// Modular Firebase v10+ initialization and exports
// Replace the below config with your actual Firebase project config
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyCGrdUEVh_EMwDQpoZU5T_SeuPl6AoaDOA",
  authDomain: "dots-box.firebaseapp.com",
  databaseURL: "https://dots-box-default-rtdb.firebaseio.com",
  projectId: "dots-box",
  storageBucket: "dots-box.firebasestorage.app",
  messagingSenderId: "631250942016",
  appId: "1:631250942016:web:66f207673e99ff8ac347a5",
  measurementId: "G-0W69LC7MRM"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);

export { app, db, auth };
