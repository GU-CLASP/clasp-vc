import { useMemo } from "react";

import AdminPage from "./AdminPage.jsx";
import RecordingView from "./RecordingView.jsx";
import ParticipantView from "./ParticipantView.jsx";
import {
  parseInviteFromUrl,
  isAdminPath,
  isRecordingPath,
} from "./app-utils.js";

export default function App() {
  const { adminKey } = useMemo(parseInviteFromUrl, []);

  // Check if admin path
  const admin = useMemo(isAdminPath, []);
  const recording = useMemo(isRecordingPath, []);

  // If admin path, show admin page
  if (admin) {
    if (adminKey) {
      // Store admin key in sessionStorage for API calls
      sessionStorage.setItem("adminKey", adminKey);
      return <AdminPage />;
    } else {
      return (
        <div style={{ padding: 24, fontFamily: "system-ui" }}>
          <h2>Admin Access Required</h2>
          <p>This page requires an admin key.</p>
          <p>
            Use the URL format: <code>/admin?adminKey=YOUR_ADMIN_KEY</code>
          </p>
        </div>
      );
    }
  }
  if (recording) {
    return <RecordingView />;
  }
  return <ParticipantView />;
}
