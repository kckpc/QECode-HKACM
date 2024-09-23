const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');
const https = require('https');

const app = express();
const uploadDir = 'uploads/';
const dataFilePath = path.join(__dirname, 'participants_data.json');

if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir);
}

const upload = multer({
  dest: uploadDir,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
        file.mimetype === "application/vnd.ms-excel") {
      cb(null, true);
    } else {
      cb(null, false);
      return cb(new Error('Only .xlsx and .xls format allowed!'));
    }
  }
});

app.use(cors({
  origin: 'https://192.168.0.119:3000', // 你的前端應用 URL
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(bodyParser.json());

let participants = {};
let isDemoMode = true;
let dailyCheckInCount = 0;

if (fs.existsSync(dataFilePath)) {
  const data = fs.readFileSync(dataFilePath, 'utf8');
  participants = JSON.parse(data);
}

function saveParticipantsData() {
  fs.writeFileSync(dataFilePath, JSON.stringify(participants, null, 2));
}

function resetDailyCheckInCount() {
  const now = new Date();
  const night = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  const msToMidnight = night.getTime() - now.getTime();

  setTimeout(() => {
    dailyCheckInCount = 0;
    resetDailyCheckInCount();
  }, msToMidnight);
}

resetDailyCheckInCount();

app.post('/api/set-demo-mode', (req, res) => {
  const { isDemoMode: newMode } = req.body;
  isDemoMode = newMode;
  res.json({ success: true, message: `Switched to ${isDemoMode ? 'Demo' : 'Production'} mode` });
});

app.get('/api/participants', (req, res) => {
  const participantList = Object.entries(participants).map(([id, data]) => ({
    id,
    ...data
  }));
  res.json(participantList);
});

app.post('/api/clear-participants', (req, res) => {
  try {
    participants = {};
    saveParticipantsData();
    res.json({ message: 'All participant data cleared successfully', totalPeople: 0 });
  } catch (error) {
    res.status(500).send('Error clearing participant data');
  }
});

app.post('/api/upload-participants', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded.');
  }

  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);

    participants = {};

    data.forEach(row => {
      participants[row.id] = {
        name: row.cname || '',
        ename: row.ename || '',
        email: row.email || '',
        voice: row.voice || '',
        isValid: row.status.toLowerCase() === 'valid',
        checkIns: []
      };
    });

    saveParticipantsData();

    res.json({ message: 'Participants updated successfully', totalPeople: Object.keys(participants).length });
  } catch (error) {
    res.status(500).send('Error processing file');
  } finally {
    fs.unlink(req.file.path, (err) => {
      if (err) {
        console.error('Error deleting temporary file:', err);
      }
    });
  }
});

app.get('/api/export-checkins', (req, res) => {
  try {
    const checkInRecords = Object.entries(participants).map(([id, data], index) => {
      const record = {
        '序號': index + 1,
        ID: id,
        'Chinese Name': data.name,
        'English Name': data.ename,
        Email: data.email,
        Voice: data.voice,
      };

      for (let i = 0; i < 10; i++) {
        record[`Check-in ${i + 1}`] = data.checkIns && data.checkIns[i] 
          ? moment.tz(data.checkIns[i], "Asia/Hong_Kong").format('YYYY-MM-DD HH:mm:ss')
          : '';
      }

      return record;
    });
    
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(checkInRecords);
    
    ws['!cols'] = [
      { wch: 8 }, { wch: 10 }, { wch: 20 }, { wch: 20 }, { wch: 30 }, { wch: 10 },
      ...Array(10).fill({ wch: 20 })
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'Check-ins');
    
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    res.setHeader('Content-Disposition', 'attachment; filename=checkins.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    
    res.send(buf);
  } catch (error) {
    console.error('Error exporting check-ins:', error);
    res.status(500).json({ message: 'Error exporting check-ins' });
  }
});

// Add this new endpoint
app.get('/api/total-people', (req, res) => {
  const totalPeople = Object.keys(participants).length;
  res.json({ totalPeople });
});

app.get('/api/daily-check-in-count', (req, res) => {
  res.json({ dailyCheckInCount });
});

app.post('/api/check-in', (req, res) => {
  const { qrData, checkInTime, isDemoMode, activityName } = req.body;
  const participant = participants[qrData];

  if (participant) {
    if (participant.isValid) {
      const hkTime = moment.tz(checkInTime, "Asia/Hong_Kong");
      const today = hkTime.format('YYYY-MM-DD');
      const todayCheckIns = participant.checkIns ? participant.checkIns.filter(checkIn => 
        moment.tz(checkIn, "Asia/Hong_Kong").format('YYYY-MM-DD') === today
      ) : [];

      if (todayCheckIns.length === 0 || isDemoMode) {
        if (!participant.checkIns) {
          participant.checkIns = [];
        }
        participant.checkIns.unshift(hkTime.toISOString());
        if (participant.checkIns.length > 10) {
          participant.checkIns = participant.checkIns.slice(0, 10);
        }
        dailyCheckInCount++;
        saveParticipantsData();
        res.json({ 
          message: `${participant.name}，簽到成功。請進入活動場地。`, 
          participant: {
            name: participant.name,
            ename: participant.ename,
            email: participant.email,
            voice: participant.voice,
            isValid: participant.isValid,
            checkIns: participant.checkIns
          },
          multipleCheckIns: todayCheckIns.length > 0,
          checkInCount: todayCheckIns.length + 1,
          dailyCheckInCount: dailyCheckInCount,
          totalPeople: Object.keys(participants).length,
          activityName: activityName
        });
      } else {
        res.json({ 
          message: `${participant.name}，您今天已經簽到過了。`, 
          participant: {
            name: participant.name,
            ename: participant.ename,
            email: participant.email,
            voice: participant.voice,
            isValid: participant.isValid,
            checkIns: participant.checkIns
          },
          multipleCheckIns: true,
          checkInCount: todayCheckIns.length + 1,
          dailyCheckInCount: dailyCheckInCount,
          totalPeople: Object.keys(participants).length,
          activityName: activityName
        });
      }
    } else {
      res.json({ 
        message: '抱歉，您的資料無效。',
        dailyCheckInCount: dailyCheckInCount,
        totalPeople: Object.keys(participants).length,
        activityName: activityName
      });
    }
  } else {
    res.json({ 
      message: '找不到參與者資料。',
      dailyCheckInCount: dailyCheckInCount,
      totalPeople: Object.keys(participants).length,
      activityName: activityName
    });
  }
});

const options = {
  key: fs.readFileSync('key.pem'),
  cert: fs.readFileSync('cert.pem')
};

const PORT = process.env.PORT || 3001;
https.createServer(options, app).listen(PORT, '0.0.0.0', () => {
  console.log(`HTTPS Server is running on port ${PORT}`);
});