const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
require('dotenv').config(); // Chargement des variables d'environnement

const app = express();
const server = http.createServer(app);
const io = socketio(server, {cors: {origin: "*"}});

// Chaîne de connexion MongoDB
const MONGODB_URI = 'mongodb+srv://qmouraud:RWRk4FgMHqpDDvBs@geoloc.oydw5i7.mongodb.net/?retryWrites=true&w=majority&appName=GeoLOCy';

// Connexion à MongoDB
mongoose.connect(MONGODB_URI)
  .then(() => console.log('MongoDB connecté'))
  .catch(err => console.error('Erreur MongoDB:', err));

// Gestion des erreurs de connexion
mongoose.connection.on('error', (err) => {
  console.error('Erreur de connexion MongoDB:', err);
  setTimeout(() => {
    mongoose.connect(MONGODB_URI);
  }, 5000);
});

mongoose.connection.on('disconnected', () => {
  console.log('MongoDB déconnecté, tentative de reconnexion...');
  setTimeout(() => {
    mongoose.connect(MONGODB_URI);
  }, 5000);
});

// ===== DÉFINITION DES MODÈLES MONGOOSE =====

// Modèle pour les statistiques globales
const StatsSchema = new mongoose.Schema({
  id: { type: String, default: 'global' },
  online: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  lastUpdated: { type: Date, default: Date.now }
});
const Stats = mongoose.model('Stats', StatsSchema);

// Historique des statistiques
const StatsHistorySchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  online: { type: Number, default: 0 },
  averageScore: { type: Number, default: 0 },
  activeGames: { type: Number, default: 0 }
});
const StatsHistory = mongoose.model('StatsHistory', StatsHistorySchema);

// Modèle pour l'historique des parties
const GameHistorySchema = new mongoose.Schema({
  gameId: { type: String, required: true },
  startTime: { type: Date, default: Date.now },
  endTime: { type: Date },
  rounds: { type: Number, default: 0 },
  players: [{ 
    pseudo: String, 
    score: Number 
  }],
  locations: [{ 
    lat: Number, 
    lng: Number 
  }]
});
const GameHistory = mongoose.model('GameHistory', GameHistorySchema);

// Modèle pour le classement (leaderboard)
const LeaderboardSchema = new mongoose.Schema({
  pseudo: { type: String, required: true, unique: true },
  score: { type: Number, default: 0 },
  date: { type: Date, default: Date.now }
});
const Leaderboard = mongoose.model('Leaderboard', LeaderboardSchema);

// ===== VARIABLES GLOBALES =====
let onlinePlayers = 0;
let totalPlayers = 0;
let leaderboard = []; // Cache du leaderboard
const recentPlayers = [];
const MAX_RECENT_PLAYERS = 5;
const games = new Map();
const playerStates = new Map(); // Pour suivre l'état de chaque joueur

// Historique des joueurs pour le calcul de tendances
const playersHistory = {
  timestamps: [],
  counts: [],
  maxEntries: 24 // Garder 24 entrées (pour suivre les dernières 24h avec une mesure/heure)
};

// ===== FONCTIONS D'INITIALISATION =====

// Chargement des statistiques au démarrage
async function initStats() {
  try {
    const stats = await Stats.findOne({ id: 'global' });
    if (stats) {
      totalPlayers = stats.total;
      console.log(`Statistiques chargées: ${totalPlayers} joueurs au total`);
    } else {
      await Stats.create({ 
        id: 'global', 
        online: 0, 
        total: 0,
        lastUpdated: new Date()
      });
      console.log('Document de statistiques créé');
    }
  } catch (err) {
    console.error('Erreur lors du chargement des statistiques:', err);
  }
}

// Chargement du leaderboard depuis MongoDB
async function loadLeaderboard() {
  try {
    leaderboard = await Leaderboard.find().sort({ score: -1 }).limit(10).lean();
    console.log(`Leaderboard chargé: ${leaderboard.length} joueurs`);
  } catch (err) {
    console.error('Erreur lors du chargement du leaderboard:', err);
  }
}

// ===== FONCTIONS UTILITAIRES =====

// Génération d'un ID de partie
function generateGameId() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// Enregistrer un joueur récent
function addRecentPlayer(pseudo) {
  if (!pseudo || pseudo === 'Joueur') return;
  
  // Supprimer si existe déjà
  const existingIndex = recentPlayers.findIndex(p => p.pseudo === pseudo);
  if (existingIndex >= 0) {
    recentPlayers.splice(existingIndex, 1);
  }
  
  // Ajouter en tête de liste
  recentPlayers.unshift({
    pseudo: pseudo,
    time: new Date().toISOString()
  });
  
  // Limiter la taille
  if (recentPlayers.length > MAX_RECENT_PLAYERS) {
    recentPlayers.length = MAX_RECENT_PLAYERS;
  }
}

// Sauvegarder un score dans MongoDB
async function saveScore(player) {
  if (!player.pseudo || player.pseudo === 'Joueur') return;
  
  try {
    const existing = await Leaderboard.findOne({ pseudo: player.pseudo });
    if (!existing || player.score > existing.score) {
      await Leaderboard.findOneAndUpdate(
        { pseudo: player.pseudo },
        { score: player.score, date: new Date() },
        { upsert: true }
      );
      await loadLeaderboard(); // Recharger le leaderboard en mémoire
      console.log(`Score de ${player.pseudo} enregistré: ${player.score}`);
    }
  } catch (err) {
    console.error('Erreur lors de la sauvegarde du score:', err);
  }
}

// Sauvegarder l'historique d'une partie
async function saveGameToHistory(gameId, game, finalResults) {
  try {
    await GameHistory.create({
      gameId: gameId,
      startTime: game.startTime || new Date(Date.now() - 1000 * 60 * game.rounds),
      endTime: new Date(),
      rounds: game.rounds,
      players: finalResults,
      locations: game.locations || []
    });
    
    console.log(`Partie ${gameId} sauvegardée dans l'historique`);
  } catch (err) {
    console.error('Erreur lors de l\'enregistrement de l\'historique de partie:', err);
  }
}

// Calculer le score moyen
function calculateAverageScore() {
  // Si nous avons des scores dans le leaderboard
  if (leaderboard.length > 0) {
    const sum = leaderboard.reduce((total, player) => total + player.score, 0);
    return Math.round(sum / leaderboard.length);
  }
  
  // Si nous avons des parties actives, calculer la moyenne des scores en cours
  let activePlayers = 0;
  let activeScoresSum = 0;
  
  games.forEach(game => {
    game.players.forEach(player => {
      activePlayers++;
      activeScoresSum += player.score || 0;
    });
  });
  
  if (activePlayers > 0) {
    return Math.round(activeScoresSum / activePlayers);
  }
  
  return 0; // Pas de scores disponibles
}

// Calculer la tendance d'activité
function calculateOnlineTrend() {
  const now = Date.now();
  
  // Ajouter le nombre actuel à l'historique
  playersHistory.timestamps.push(now);
  playersHistory.counts.push(onlinePlayers);
  
  // Ne garder que les X dernières entrées
  if (playersHistory.timestamps.length > playersHistory.maxEntries) {
    playersHistory.timestamps.shift();
    playersHistory.counts.shift();
  }
  
  // Si nous avons suffisamment d'historique (au moins 2 points)
  if (playersHistory.counts.length >= 2) {
    // Comparer avec la valeur la plus ancienne
    const current = onlinePlayers;
    const previous = playersHistory.counts[0];
    
    return current - previous;
  }
  
  return 0; // Pas assez de données
}

// Sauvegarder les statistiques de joueurs
async function savePlayerStats() {
  try {
    await Stats.findOneAndUpdate(
      { id: 'global' },
      { 
        online: onlinePlayers,
        total: totalPlayers,
        lastUpdated: new Date()
      },
      { upsert: true }
    );
    console.log(`Statistiques sauvegardées: ${onlinePlayers} en ligne, ${totalPlayers} au total`);
  } catch (err) {
    console.error('Erreur lors de la sauvegarde des statistiques:', err);
  }
}

// Générer des lieux aléatoires
async function generateLocations(count) {
  // Coordonnées aléatoires (à améliorer avec l'API StreetView)
  const locations = [];
  for (let i = 0; i < count; i++) {
    locations.push({
      lat: Math.random() * 160 - 80,
      lng: Math.random() * 360 - 180
    });
  }
  return locations;
}

// ===== INITIALISATION AU DÉMARRAGE =====
initStats();
loadLeaderboard();

// ===== ROUTES EXPRESS =====
app.get('/', (req, res) => {
  // Lire le fichier index.html et remplacer la clé API
  const indexPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(indexPath, 'utf8', (err, data) => {
    if (err) {
      console.error('Erreur de lecture du fichier index.html:', err);
      return res.status(500).send('Erreur serveur');
    }
    
    const apiKey = process.env.GOOGLE_MAPS_API_KEY || '';
    const modifiedHtml = data.replace('GOOGLE_MAPS_API_KEY_PLACEHOLDER', apiKey);
    
    res.send(modifiedHtml);
  });
});

app.get('/admin', (req, res) => {
  const password = req.query.key;
  const adminPassword = 'QUENTIN44';
  
  if (password === adminPassword) {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  } else {
    res.status(403).send('<h1>Accès refusé</h1><p>Mot de passe incorrect</p>');
  }
});

// Route ping pour maintenir le service actif
app.get('/ping', (req, res) => {
  console.log('Ping reçu à', new Date().toISOString());
  res.status(200).send('OK');
});

// Fichiers statiques
app.use(express.static(path.join(__dirname, 'public')));

// ===== GESTIONNAIRES SOCKET.IO =====
io.on('connection', (socket) => {
  console.log('Nouvelle connexion:', socket.id);

  // Incrémenter le nombre de joueurs connectés
  onlinePlayers++;
  totalPlayers++;

  // Sauvegarder les statistiques
  savePlayerStats();

  // Envoyer les statistiques aux clients qui les demandent
  socket.on('getPlayerStats', () => {
    socket.emit('playerStats', {
      online: onlinePlayers,
      total: totalPlayers
    });
  });

  socket.on('createGame', (config) => {
    const gameId = generateGameId();
    const player = {
      id: socket.id,
      pseudo: config.pseudo,
      score: 0,
      isHost: true
    };
    
    games.set(gameId, {
      players: new Map([[socket.id, player]]),
      rounds: config.rounds,
      currentRound: 0,
      locations: [],
      started: false
    });
    
    socket.join(gameId);
    socket.gameId = gameId;
    socket.emit('gameCreated', gameId);
    io.to(gameId).emit('playerJoined', Array.from(games.get(gameId).players.values()));
  });

  socket.on('joinGame', (gameId, pseudo) => {
    gameId = gameId.toUpperCase();
    
    if (!games.has(gameId)) {
      return socket.emit('gameError', 'Partie introuvable');
    }
    
    const game = games.get(gameId);
    
    if (game.started) {
      return socket.emit('gameError', 'La partie a déjà commencé');
    }
    
    const player = {
      id: socket.id,
      pseudo: pseudo,
      score: 0,
      isHost: false
    };
    
    game.players.set(socket.id, player);
    socket.join(gameId);
    socket.gameId = gameId;
    
    // Informer tout le monde dans la partie
    io.to(gameId).emit('playerJoined', Array.from(game.players.values()));
    
    // Confirmer au joueur qui vient de rejoindre
    socket.emit('joinedGame', gameId, Array.from(game.players.values()));
  });

  socket.on('leaveGame', (gameId) => {
    if (!gameId || !games.has(gameId)) return;
    
    const game = games.get(gameId);
    game.players.delete(socket.id);
    
    if (game.players.size === 0) {
      games.delete(gameId);
    } else {
      io.to(gameId).emit('playerJoined', Array.from(game.players.values()));
      
      // Si l'hôte quitte, désigner un nouvel hôte
      if (Array.from(game.players.values()).every(p => !p.isHost)) {
        const newHost = Array.from(game.players.values())[0];
        newHost.isHost = true;
        io.to(gameId).emit('playerJoined', Array.from(game.players.values()));
      }
    }
    
    socket.leave(gameId);
    delete socket.gameId;
  });

  socket.on('startMultiGame', async (gameId, rounds) => {
    if (!gameId || !games.has(gameId)) return;
    
    const game = games.get(gameId);
    
    // Vérifier si le joueur est l'hôte
    const player = game.players.get(socket.id);
    if (!player || !player.isHost) return;
    
    if (rounds) {
      game.rounds = rounds;
    }
    
    // Demander au client de proposer des emplacements
    socket.emit('requestLocations', gameId, game.rounds);
  });

  socket.on('proposeLocations', (gameId, locations) => {
    if (!gameId || !games.has(gameId)) return;
    
    const game = games.get(gameId);
    game.locations = locations;
    game.started = true;
    game.startTime = new Date();
    
    io.to(gameId).emit('gameStarted', {
      rounds: game.rounds,
      currentRound: 0,
      locations: game.locations,
      players: Array.from(game.players.values())
    });
    
    console.log(`Partie ${gameId} démarrée avec ${game.players.size} joueurs et ${game.rounds} manches`);
  });

  socket.on('submitGuess', (gameId, guessData) => {
    if (!gameId || !games.has(gameId)) return;
    
    const game = games.get(gameId);
    const player = game.players.get(socket.id);
    
    if (!player) return;
    
    // Stocker le score du joueur
    player.score = (player.score || 0) + guessData.score;
    
    // Stocker le résultat pour ce tour avec la position du joueur
    if (!game.roundResults) {
      game.roundResults = new Map();
    }
    
    game.roundResults.set(socket.id, {
      playerId: socket.id,
      pseudo: player.pseudo,
      distance: guessData.distance,
      score: guessData.score,
      position: guessData.position // Stocker la position du joueur
    });
    
    console.log(`Joueur ${player.pseudo} a deviné avec ${guessData.distance}km de distance, score: ${guessData.score}`);
    
    // Informer le joueur que sa réponse est enregistrée (mais pas encore les résultats)
    socket.emit('guessRegistered');
    
    // Informer tous les joueurs du nombre de réponses
    const totalPlayers = game.players.size;
    const answeredPlayers = game.roundResults.size;
    io.to(gameId).emit('guessProgress', {
      answered: answeredPlayers,
      total: totalPlayers
    });
    
    // Vérifier si tous les joueurs ont répondu
    if (game.roundResults.size === game.players.size) {
      const results = Array.from(game.roundResults.values());
      const currentLocation = game.locations[game.currentRound];
      
      // Envoyer les résultats à tous les joueurs avec la position réelle et toutes les positions des joueurs
      io.to(gameId).emit('roundComplete', {
        results: results,
        actualPosition: currentLocation
      });
      
      // Après un délai, passer à la manche suivante
      setTimeout(() => {
        game.currentRound++;
        
        // Réinitialiser les résultats pour la prochaine manche
        game.roundResults = new Map();
        
        if (game.currentRound < game.rounds) {
          // Passer à la manche suivante
          io.to(gameId).emit('nextRound', game.currentRound);
        } else {
          // Fin de la partie
          const finalResults = Array.from(game.players.values())
            .map(p => ({ pseudo: p.pseudo, score: p.score }))
            .sort((a, b) => b.score - a.score);
          
          // Enregistrer la partie terminée dans MongoDB
          saveGameToHistory(gameId, game, finalResults);
          
          io.to(gameId).emit('endGame', finalResults);
        }
      }, 10000); // Augmenter le délai à 10 secondes pour laisser le temps de voir les résultats
    }
  });

  socket.on('disconnect', () => {
    console.log('Déconnexion:', socket.id);
    
    // Si le joueur était dans une partie
    if (socket.gameId && games.has(socket.gameId)) {
      const gameId = socket.gameId;
      const game = games.get(gameId);
      
      game.players.delete(socket.id);
      
      if (game.players.size === 0) {
        games.delete(gameId);
      } else {
        io.to(gameId).emit('playerJoined', Array.from(game.players.values()));
        
        // Si l'hôte quitte, désigner un nouvel hôte
        if (Array.from(game.players.values()).every(p => !p.isHost)) {
          const newHost = Array.from(game.players.values())[0];
          newHost.isHost = true;
          io.to(gameId).emit('playerJoined', Array.from(game.players.values()));
        }
      }
    }

    // Décrémenter lors de la déconnexion
    onlinePlayers--;
    
    // Mettre à jour les stats pour tous
    io.emit('playerStats', {
      online: onlinePlayers,
      total: totalPlayers
    });
  });

  // Événements de leaderboard et joueurs récents
  socket.on('getLeaderboard', async () => {
    try {
      const topScores = await Leaderboard.find().sort({ score: -1 }).limit(10).lean();
      socket.emit('leaderboardData', topScores);
    } catch (err) {
      console.error('Erreur lors de la récupération du leaderboard:', err);
      socket.emit('leaderboardData', []);
    }
  });

  socket.on('getRecentPlayers', () => {
    socket.emit('recentPlayersData', recentPlayers);
  });

  socket.on('registerPlayer', (pseudo) => {
    if (pseudo) {
      addRecentPlayer(pseudo);
    }
  });

  socket.on('saveScore', async (player) => {
    await saveScore(player);
  });

  // Événements d'administration
  socket.on('adminAuth', () => {
    socket.join('admin-room');
  });

  socket.on('getAdminData', () => {
    if (!socket.rooms.has('admin-room')) return;

    const adminData = {
      onlinePlayers,
      totalPlayers,
      activeGames: games.size,
      averageScore: calculateAverageScore(),
      onlineTrend: calculateOnlineTrend(),
      serverInfo: {
        version: '1.0.0',
        uptime: Math.floor(process.uptime()),
        memory: process.memoryUsage().heapUsed,
        cpu: Math.floor(Math.random() * 20) + 5, // Simulation
        disk: '135.39 MB / 512.00 MB',
        nodeVersion: process.version
      }
    };

    socket.emit('adminData', adminData);
  });

  socket.on('getConnectedPlayers', () => {
    if (!socket.rooms.has('admin-room')) return;

    const connectedPlayers = [];
    
    io.sockets.sockets.forEach(clientSocket => {
      if (clientSocket.pseudo) {
        connectedPlayers.push({
          id: clientSocket.id,
          pseudo: clientSocket.pseudo || 'Anonyme',
          status: clientSocket.gameId ? 'active' : 'menu',
          connectedSince: clientSocket.connectTime || new Date(),
          ip: clientSocket.handshake.address.replace(/^::ffff:/, '')
        });
      }
    });

    socket.emit('connectedPlayers', connectedPlayers);
  });

  socket.on('getActiveGames', () => {
    if (!socket.rooms.has('admin-room')) return;

    const activeGames = [];
    
    games.forEach((game, gameId) => {
      activeGames.push({
        id: gameId,
        type: 'Multijoueur',
        players: game.players.size,
        maxPlayers: 10,
        currentRound: game.currentRound + 1,
        totalRounds: game.rounds,
        startedAt: game.startTime || new Date()
      });
    });

    socket.emit('activeGames', activeGames);
  });

  socket.on('disconnectPlayer', (playerId) => {
    if (!socket.rooms.has('admin-room')) return;
    
    const playerSocket = io.sockets.sockets.get(playerId);
    if (playerSocket) {
      playerSocket.disconnect(true);
    }
  });

  socket.on('stopGame', (gameId) => {
    if (!socket.rooms.has('admin-room')) return;
    
    if (games.has(gameId)) {
      const game = games.get(gameId);
      io.to(gameId).emit('gameStoppedByAdmin');
      games.delete(gameId);
    }
  });

  socket.on('updateSettings', (settings) => {
    if (!socket.rooms.has('admin-room')) return;
    console.log('Nouveaux paramètres:', settings);
  });

  socket.on('getActivityHistory', () => {
    if (!socket.rooms.has('admin-room')) return;
    
    socket.emit('activityHistory', {
      timestamps: playersHistory.timestamps,
      counts: playersHistory.counts
    });
  });

  socket.on('getDetailedStats', () => {
    if (!socket.rooms.has('admin-room')) return;
    
    // Distribution des scores
    const scoreDistribution = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // 10 catégories
    
    leaderboard.forEach(player => {
      const score = player.score;
      const index = Math.min(9, Math.floor(score / 500)); // 0-500, 500-1000, etc.
      if (index >= 0 && index < 10) {
        scoreDistribution[index]++;
      }
    });
    
    // Activité quotidienne
    const dailyActivity = [0, 0, 0, 0, 0, 0, 0]; // 7 derniers jours
    
    // Destinations difficiles
    const difficultLocations = [];
    
    socket.emit('detailedStats', {
      scoreDistribution,
      dailyActivity,
      difficultLocations
    });
  });

  socket.on('getGameHistory', async () => {
    if (!socket.rooms.has('admin-room')) return;
    
    try {
      const history = await GameHistory.find()
        .sort({ endTime: -1 })
        .limit(20);
      
      socket.emit('gameHistory', history);
    } catch (err) {
      console.error('Erreur lors de la récupération de l\'historique:', err);
      socket.emit('gameHistory', []);
    }
  });

  socket.on('heartbeat', (gameId, currentRound) => {
    // Vérifier si le joueur est dans la bonne manche
    if (gameId && games.has(gameId)) {
      const game = games.get(gameId);
      
      // Si le joueur est en retard d'une manche ou plus
      if (game.currentRound > currentRound) {
        console.log(`Resynchronisation du joueur ${socket.id}, manche ${currentRound} -> ${game.currentRound}`);
        
        // Renvoyer l'état actuel de la partie
        socket.emit('syncGameState', {
          currentRound: game.currentRound,
          players: Array.from(game.players.values()),
          location: game.locations[game.currentRound]
        });
        
        // Si le joueur est bloqué sur la vue des résultats
        if (game.roundResults && game.roundResults.size === game.players.size) {
          const results = Array.from(game.roundResults.values());
          const currentLocation = game.locations[game.currentRound - 1]; // Manche précédente
          
          socket.emit('roundComplete', {
            results: results,
            actualPosition: currentLocation
          });
        } else {
          // Juste passer à la manche actuelle
          socket.emit('nextRound', game.currentRound);
        }
      }
    }
  });
});

// ===== TÂCHES PLANIFIÉES =====

// Mise à jour de l'historique des joueurs (pour la tendance)
setInterval(() => {
  calculateOnlineTrend();
}, 3600000); // 1 heure

// Enregistrer l'historique des statistiques
setInterval(async () => {
  try {
    await StatsHistory.create({
      timestamp: new Date(),
      online: onlinePlayers,
      averageScore: calculateAverageScore(),
      activeGames: games.size
    });
    console.log('Historique des statistiques enregistré');
  } catch (err) {
    console.error('Erreur lors de l\'enregistrement de l\'historique:', err);
  }
}, 3600000); // 1 heure

// ===== DÉMARRAGE DU SERVEUR =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
