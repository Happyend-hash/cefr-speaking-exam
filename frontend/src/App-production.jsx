import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './App.css';

// For production, use relative URLs or environment variable
const API_URL = process.env.REACT_APP_API_URL || (
  process.env.NODE_ENV === 'production'
    ? '' // In production, use relative URLs (same domain)
    : 'http://localhost:5000/api'
);

function App() {
  const [currentPage, setCurrentPage] = useState('home');
  const [user, setUser] = useState(null);
  const [exams, setExams] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [formData, setFormData] = useState({ email: '', password: '', name: '' });

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      setUser(JSON.parse(localStorage.getItem('user') || '{}'));
      loadExams();
    }
  }, []);

  const loadExams = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get(`${API_URL}/api/exam/list`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setExams(response.data.exams || []);
    } catch (err) {
      console.error('Error loading exams:', err);
    }
  };

  const handleInputChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSignup = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const response = await axios.post(`${API_URL}/api/auth/signup`, formData);
      localStorage.setItem('token', response.data.token);
      localStorage.setItem('user', JSON.stringify(response.data.user));
      setUser(response.data.user);
      setCurrentPage('dashboard');
      loadExams();
    } catch (err) {
      setError(err.response?.data?.message || 'Signup failed');
    }
    setLoading(false);
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const response = await axios.post(`${API_URL}/api/auth/login`, {
        email: formData.email,
        password: formData.password
      });
      localStorage.setItem('token', response.data.token);
      localStorage.setItem('user', JSON.stringify(response.data.user));
      setUser(response.data.user);
      setCurrentPage('dashboard');
      loadExams();
    } catch (err) {
      setError(err.response?.data?.message || 'Login failed');
    }
    setLoading(false);
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
    setCurrentPage('home');
    setFormData({ email: '', password: '', name: '' });
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
        <nav className="bg-white shadow-md sticky top-0 z-50">
          <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
            <h1 className="text-2xl font-bold text-indigo-600">CEFR Exam</h1>
            <button onClick={() => setCurrentPage(currentPage === 'login' ? 'home' : 'login')} className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
              {currentPage === 'login' ? 'Home' : 'Login'}
            </button>
          </div>
        </nav>

        {currentPage === 'home' && (
          <div className="max-w-7xl mx-auto px-4 py-20 text-center">
            <h2 className="text-5xl font-bold mb-6 text-gray-800">Master Your English Speaking Skills</h2>
            <p className="text-xl text-gray-600 mb-8 max-w-2xl mx-auto">Get AI-powered evaluation with Claude AI.</p>
            <div className="flex gap-4 justify-center">
              <button onClick={() => setCurrentPage('signup')} className="px-8 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-semibold text-lg">Get Started</button>
              <button onClick={() => setCurrentPage('login')} className="px-8 py-3 border-2 border-indigo-600 text-indigo-600 rounded-lg hover:bg-indigo-50 font-semibold text-lg">Sign In</button>
            </div>
          </div>
        )}

        {currentPage === 'signup' && (
          <div className="max-w-md mx-auto mt-20">
            <div className="bg-white p-8 rounded-lg shadow-lg">
              <h2 className="text-2xl font-bold mb-6">Create Account</h2>
              {error && <div className="bg-red-100 text-red-700 p-4 rounded mb-4">{error}</div>}
              <form onSubmit={handleSignup}>
                <div className="mb-4">
                  <input type="text" name="name" placeholder="Full Name" value={formData.name} onChange={handleInputChange} required className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
                <div className="mb-4">
                  <input type="email" name="email" placeholder="Email" value={formData.email} onChange={handleInputChange} required className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
                <div className="mb-6">
                  <input type="password" name="password" placeholder="Password" value={formData.password} onChange={handleInputChange} required className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
                <button type="submit" disabled={loading} className="w-full bg-indigo-600 text-white py-2 rounded-lg font-semibold hover:bg-indigo-700 disabled:opacity-50">{loading ? 'Creating...' : 'Sign Up'}</button>
              </form>
              <button onClick={() => setCurrentPage('login')} className="w-full mt-4 text-indigo-600 font-semibold hover:underline">Already have account? Login</button>
            </div>
          </div>
        )}

        {currentPage === 'login' && (
          <div className="max-w-md mx-auto mt-20">
            <div className="bg-white p-8 rounded-lg shadow-lg">
              <h2 className="text-2xl font-bold mb-6">Login</h2>
              {error && <div className="bg-red-100 text-red-700 p-4 rounded mb-4">{error}</div>}
              <form onSubmit={handleLogin}>
                <div className="mb-4">
                  <input type="email" name="email" placeholder="Email" value={formData.email} onChange={handleInputChange} required className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
                <div className="mb-6">
                  <input type="password" name="password" placeholder="Password" value={formData.password} onChange={handleInputChange} required className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
                <button type="submit" disabled={loading} className="w-full bg-indigo-600 text-white py-2 rounded-lg font-semibold hover:bg-indigo-700 disabled:opacity-50">{loading ? 'Logging in...' : 'Login'}</button>
              </form>
              <button onClick={() => setCurrentPage('signup')} className="w-full mt-4 text-indigo-600 font-semibold hover:underline">No account? Sign up</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <nav className="bg-white shadow-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
          <h1 className="text-2xl font-bold text-indigo-600">CEFR Exam</h1>
          <div className="flex items-center gap-4">
            <span className="text-gray-700">Welcome, {user.name}!</span>
            <button onClick={handleLogout} className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700">Logout</button>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 py-12">
        <h2 className="text-4xl font-bold mb-8 text-gray-800">Your Dashboard</h2>
        <div className="grid md:grid-cols-3 gap-6 mb-12">
          <div className="bg-white p-6 rounded-lg shadow-lg"><p className="text-gray-600">Total Exams</p><p className="text-3xl font-bold text-indigo-600">{exams.length}</p></div>
          <div className="bg-white p-6 rounded-lg shadow-lg"><p className="text-gray-600">Current Level</p><p className="text-3xl font-bold text-indigo-600">-</p></div>
          <div className="bg-white p-6 rounded-lg shadow-lg"><p className="text-gray-600">Score</p><p className="text-3xl font-bold text-indigo-600">-</p></div>
        </div>
        <h3 className="text-2xl font-bold mb-6">Available Exams</h3>
        {exams.length > 0 ? (
          <div className="grid md:grid-cols-2 gap-6">{exams.map((exam) => (<div key={exam._id} className="bg-white p-6 rounded-lg shadow-lg"><h4 className="text-xl font-bold mb-2">{exam.title}</h4><p className="text-gray-600 mb-4">{exam.description}</p><button className="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">Start Exam</button></div>))}</div>
        ) : (
          <div className="bg-white p-12 rounded-lg shadow-lg text-center text-gray-600"><p>No exams available yet. Check back soon!</p></div>
        )}
      </div>
    </div>
  );
}

export default App;
