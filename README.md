# ResiBand — Real-Time 4-Band & 5-Band Resistor Color Decoder

![React](https://img.shields.io/badge/React-Frontend-blue)
![Vite](https://img.shields.io/badge/Vite-Build%20Tool-purple)
![Canvas API](https://img.shields.io/badge/Canvas-Image%20Processing-green)
![Vercel](https://img.shields.io/badge/Deployed%20on-Vercel-black)
![License](https://img.shields.io/badge/License-MIT-yellow.svg)

🔴 **Live Demo:** https://resistor-value-finder.vercel.app/

ResiBand is a browser-based resistor color band decoder that uses your device's camera to identify resistor color bands and calculate resistance values in real time.

Built using **React**, **Vite**, and the **HTML5 Canvas API**, the application performs lightweight computer vision and image processing directly in the browser without requiring native applications or heavy external libraries.

Designed for students, hobbyists, educators, and electronics enthusiasts, ResiBand provides a fast and interactive way to decode resistor values using only a smartphone or computer camera.

---

## Features

- Real-time resistor color band detection
- Supports both 4-band and 5-band resistors
- Instant resistance value calculation
- Automatic tolerance identification
- Resistance range calculation (minimum and maximum values)
- Live camera processing using Canvas API
- Mobile-friendly interface
- Browser-based camera access
- Lightweight image-processing pipeline
- No OpenCV dependency
- No installation required
- Works on desktop and mobile browsers

---

## Live Website

🌐 **Try ResiBand Online**

https://resistor-value-finder.vercel.app/

> Camera permission is required for real-time resistor detection.

---

## Demo Workflow

1. Open the website.
2. Allow camera access.
3. Select 4-band or 5-band mode.
4. Align the resistor inside the guide area.
5. The application detects the resistor bands.
6. Resistance value and tolerance are calculated instantly.

---

## Technology Stack

### Frontend

- React.js
- Vite
- JavaScript (ES6+)
- HTML5
- CSS3

### Browser APIs

- MediaDevices API
- Canvas 2D API
- RequestAnimationFrame API

### Deployment

- Vercel

---

## Project Structure

```text
src/
├── main.jsx                 # React entry point
├── App.jsx                  # Main application component
├── index.css                # Global styling
├── resistorLogic.js         # Color matching and resistance calculations
├── cvProcessing.js          # Image processing functions
└── components/
    ├── ResistorVisual.jsx   # Resistor visualization
    ├── BandsDisplay.jsx     # Detected band display
    └── ColorReference.jsx   # Color code reference table
```

---

## How It Works

### 1. Camera Capture

The application accesses the device camera using:

```javascript
navigator.mediaDevices.getUserMedia()
```

Video frames are streamed into a hidden HTML5 canvas for processing.

---

### 2. Image Processing

For every frame:

- Raw pixel data is extracted from the canvas.
- A lightweight blur filter reduces sensor noise.
- A Region of Interest (ROI) is selected.
- Band sampling locations are analyzed.
- Average RGB values are calculated for each band.

---

### 3. Color Matching

Detected RGB values are compared against standard resistor color references using Euclidean distance in RGB space.

Supported resistor colors:

| Color | Digit |
|--------|--------|
| Black | 0 |
| Brown | 1 |
| Red | 2 |
| Orange | 3 |
| Yellow | 4 |
| Green | 5 |
| Blue | 6 |
| Violet | 7 |
| Grey | 8 |
| White | 9 |

Additional multiplier and tolerance colors are also supported.

---

### 4. Resistance Calculation

#### 4-Band Resistor

```text
Resistance = (Band1 × 10 + Band2) × Multiplier
```

#### 5-Band Resistor

```text
Resistance = (Band1 × 100 + Band2 × 10 + Band3) × Multiplier
```

The application calculates:

- Resistance value
- Tolerance percentage
- Minimum resistance
- Maximum resistance

---

## Local Development

Clone the repository:

```bash
git clone https://github.com/denanathsec25/resistor-value-finder.git
```

Navigate into the project:

```bash
cd resistor-value-finder
```

Install dependencies:

```bash
npm install
```

Run the development server:

```bash
npm run dev
```

Open:

```text
http://localhost:5173
```

---

## Production Build

Generate a production build:

```bash
npm run build
```

Output files will be generated in:

```text
dist/
```

---

## Deployment

This project is deployed on **Vercel**.

To deploy your own version:

1. Fork the repository
2. Import the repository into Vercel
3. Deploy

Camera access requires HTTPS in production environments.

---

## Applications

ResiBand can be used for:

- Electronics laboratory experiments
- Engineering education
- DIY electronics projects
- Circuit troubleshooting
- STEM learning activities
- Embedded systems prototyping
- Hardware development and testing
- Quick resistor identification during circuit assembly

---

## Future Enhancements

- Support for 6-band resistors
- Temperature coefficient detection
- Automatic resistor body localization
- Adaptive lighting correction
- LAB color-space classification
- AI-assisted color recognition
- SMD resistor code recognition
- Offline PWA support
- Scan history and analytics
- Export results as PDF/CSV
- Multi-language interface

---

## Why ResiBand?

Unlike traditional resistor calculators that require manual color selection, ResiBand performs real-time visual detection directly from the camera feed.

The project demonstrates practical applications of:

- Computer Vision
- Image Processing
- Frontend Engineering
- Browser APIs
- Electronics Fundamentals
- Human–Computer Interaction

while remaining lightweight enough to run entirely inside a web browser.

---

## Development Note

ResiBand was independently developed by **Denanath S** as an Electronics and Computer Vision project.

Modern AI-assisted development tools were utilized during the development process for:

- Code generation assistance
- Debugging support
- Documentation refinement
- UI/UX improvements
- Rapid prototyping and technical brainstorming

The overall system design, computer vision workflow, resistance calculation logic, testing, deployment, and project ownership remain the work of the author.

---

## Author

### Denanath S

**Electronics and Communication Engineering (ECE)**  
**Bannari Amman Institute of Technology**

📧 Email: denanathshanmugasundaram@gmail.com

🔗 GitHub: https://github.com/denanathsec25

🌐 Live Website: https://resistor-value-finder.vercel.app/

---

## Contributing

Contributions, suggestions, and improvements are welcome.

To contribute:

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push the branch
5. Open a Pull Request

---

## License

This project is licensed under the MIT License.

See the [LICENSE](LICENSE) file for details.

---

## Support

If you found this project useful:

⭐ Star the repository

🍴 Fork the project

📢 Share it with fellow students, makers, and electronics enthusiasts

Your support helps improve the project and encourages future development.

---

### Built with React, Canvas API, Computer Vision concepts, and a passion for Electronics Engineering.
