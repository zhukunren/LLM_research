import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { SecuritiesProvider } from './components/StockSearch'
import './tokens.css'
import './reset-and-shell.css'
import './components.css'
import './libraries.css'
import './workbench.css'
import './conversation.css'
import './usability.css'
import './news.css'
import './observation.css'
import './visual-polish.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SecuritiesProvider><App /></SecuritiesProvider>
  </React.StrictMode>,
)

