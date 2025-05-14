// server.js
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

// Chaîne de connexion (remplacez par la vôtre)
const MONGODB_URI = 'mongodb+srv://qmouraud:RWRk4FgMHqpDDvBs@geoloc.oydw5i7.mongodb.net/?retryWrites=true&w=majority&appName=GeoLOCy';

// Connexion à MongoDB
mongoose.connect(MONGODB_URI)
  
.then(() => console.log('MongoDB connecté'))
.catch(err => console.error('Erreur MongoDB:', err));

// Améliorez la gestion des erreurs de connexion
mongoose.connection.on('error', (err) => {
  console.error('Erreur de connexion MongoDB:', err);
  // Tentative de reconnexion après un délai
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

// Créer un modèle pour les statistiques
const StatsSchema = new mongoose.Schema({
  id: { type: String, default: 'global' },
  online: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  lastUpdated: { type: Date, default: Date.now }
});

const Stats = mongoose.model('Stats', StatsSchema);

// Historique des statistiques pour MongoDB
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

// Remplacer vos variables de statistiques par ceci
let onlinePlayers = 0;
let totalPlayers = 0;

// Charger les statistiques au démarrage
async function initStats() {
  try {
    const stats = await Stats.findOne({ id: 'global' });
    if (stats) {
      totalPlayers = stats.total;
      console.log(`Statistiques chargées: ${totalPlayers} joueurs au total`);
    } else {
      // Créer un document de statistiques s'il n'existe pas
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

// Appeler cette fonction au démarrage
initStats();

// Stockage des meilleurs scores et des joueurs récents
const leaderboard = [];
const recentPlayers = [];
const MAX_LEADERBOARD_SIZE = 10;
const MAX_RECENT_PLAYERS = 5;

// Historique des joueurs en ligne pour le calcul de tendances
const playersHistory = {
  timestamps: [],
  counts: [],
  maxEntries: 24 // Garder 24 entrées (pour suivre les dernières 24h avec une mesure/heure)
};

// Fonction pour sauvegarder un score dans le classement
function saveScore(player) {
  // Ne pas enregistrer les scores anonymes ou vides
  if (!player.pseudo || player.pseudo === 'Joueur') return;
  
  // Vérifier si le joueur existe déjà
  const existingIndex = leaderboard.findIndex(p => p.pseudo === player.pseudo);
  if (existingIndex >= 0) {
    // Mettre à jour le score si c'est meilleur
    if (player.score > leaderboard[existingIndex].score) {
      leaderboard[existingIndex].score = player.score;
      leaderboard[existingIndex].date = new Date().toISOString();
    }
  } else {
    // Ajouter un nouveau joueur
    leaderboard.push({
      pseudo: player.pseudo,
      score: player.score,
      date: new Date().toISOString()
    });
  }
  
  // Trier et limiter la taille du classement
  leaderboard.sort((a, b) => b.score - a.score);
  if (leaderboard.length > MAX_LEADERBOARD_SIZE) {
    leaderboard.length = MAX_LEADERBOARD_SIZE;
  }
}

// Fonction pour enregistrer un joueur récent
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

// Au lieu de servir simplement les fichiers statiques
// On va intercepter la requête pour index.html
app.get('/', (req, res) => {
  // Lire le fichier index.html
  const indexPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(indexPath, 'utf8', (err, data) => {
    if (err) {
      console.error('Erreur de lecture du fichier index.html:', err);
      return res.status(500).send('Erreur serveur');
    }
    
    // Remplacer le placeholder par la clé API
    const apiKey = process.env.GOOGLE_MAPS_API_KEY || '';
    const modifiedHtml = data.replace('GOOGLE_MAPS_API_KEY_PLACEHOLDER', apiKey);
    
    res.send(modifiedHtml);
  });
});

// Servir les autres fichiers statiques normalement
app.use(express.static(path.join(__dirname, 'public')));

const games = new Map();

io.on('connection', (socket) => {
  console.log('Nouvelle connexion:', socket.id);

  // Incrémenter le nombre de joueurs connectés
  onlinePlayers++;
  totalPlayers++;

  // Sauvegarder les statistiques périodiquement
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
    
    // Informer tout le monde dans la partie qu'un joueur a rejoint
    io.to(gameId).emit('playerJoined', Array.from(game.players.values()));
    
    // Informer le joueur qui vient de rejoindre qu'il a bien été connecté
    socket.emit('joinedGame', gameId, Array.from(game.players.values()));
  });

  socket.on('leaveGame', (gameId) => {
    if (!gameId || !games.has(gameId)) return;
    
    const game = games.get(gameId);
    game.players.delete(socket.id);
    
    if (game.players.size === 0) {
      // Si plus personne dans la partie, on la supprime
      games.delete(gameId);
    } else {
      // Sinon on informe les autres joueurs
      io.to(gameId).emit('playerJoined', Array.from(game.players.values()));
      
      // Si l'hôte quitte, on désigne un nouvel hôte
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
    
    // Mettre à jour le nombre de manches si fourni
    if (rounds) {
      game.rounds = rounds;
    }
    
    // On ne génère plus les emplacements ici, on attend le client
    socket.emit('requestLocations', gameId, game.rounds);
  });

  socket.on('proposeLocations', (gameId, locations) => {
    if (!gameId || !games.has(gameId)) return;
    
    const game = games.get(gameId);
    game.locations = locations;
    game.started = true;
    game.startTime = new Date(); // Ajouter l'heure de début
    
    // Envoyer les données de départ à tous les joueurs
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
    
    // Stocker le résultat pour ce tour
    if (!game.roundResults) {
      game.roundResults = new Map();
    }
    
    game.roundResults.set(socket.id, {
      playerId: socket.id,
      pseudo: player.pseudo,
      distance: guessData.distance,
      score: guessData.score
    });
    
    console.log(`Joueur ${player.pseudo} a deviné avec ${guessData.distance}km de distance, score: ${guessData.score}`);
    
    // Vérifier si tous les joueurs ont soumis leur réponse
    if (game.roundResults.size === game.players.size) {
      // Tous les joueurs ont répondu, on peut passer à la manche suivante
      const results = Array.from(game.roundResults.values());
      
      // Envoyer les résultats à tous les joueurs
      io.to(gameId).emit('roundComplete', results);
      
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
            .sort((a, b) => b.score - a.score); // Trier par score décroissant
          
          // Enregistrer la partie terminée dans l'historique
          saveGameToHistory(gameId, game, finalResults);
          
          io.to(gameId).emit('endGame', finalResults);
        }
      }, 5000); // 5 secondes pour lire les résultats
    }
  });

  socket.on('disconnect', () => {
    console.log('Déconnexion:', socket.id);
    
    // Si le joueur était dans une partie, le retirer
    if (socket.gameId && games.has(socket.gameId)) {
      const gameId = socket.gameId;
      const game = games.get(gameId);
      
      game.players.delete(socket.id);
      
      if (game.players.size === 0) {
        games.delete(gameId);
      } else {
        io.to(gameId).emit('playerJoined', Array.from(game.players.values()));
        
        // Si l'hôte quitte, on désigne un nouvel hôte
        if (Array.from(game.players.values()).every(p => !p.isHost)) {
          const newHost = Array.from(game.players.values())[0];
          newHost.isHost = true;
          io.to(gameId).emit('playerJoined', Array.from(game.players.values()));
        }
      }
    }

    // Décrémenter lors de la déconnexion
    onlinePlayers--;
    
    // Mettre à jour les stats pour tous les clients
    io.emit('playerStats', {
      online: onlinePlayers,
      total: totalPlayers
    });
  });

  // Envoyer les données de classement
  socket.on('getLeaderboard', () => {
    socket.emit('leaderboardData', leaderboard);
  });

  // Envoyer les données des joueurs récents
  socket.on('getRecentPlayers', () => {
    socket.emit('recentPlayersData', recentPlayers);
  });

  // Enregistrer le joueur comme récent à la connexion
  socket.on('registerPlayer', (pseudo) => {
    if (pseudo) {
      addRecentPlayer(pseudo);
    }
  });

  // Dans le gestionnaire 'endGame' :
  socket.on('saveScore', (player) => {
    saveScore(player);
  });

  // Événements pour l'administration
  socket.on('adminAuth', () => {
    // Vérifiez si le client est sur la page admin (via referer par exemple)
    socket.join('admin-room');
  });

  socket.on('getAdminData', () => {
    if (!socket.rooms.has('admin-room')) return;

    // Récupérer les données pour le tableau de bord
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

    // Créer un tableau des joueurs connectés
    const connectedPlayers = [];
    
    // Pour chaque socket connecté
    io.sockets.sockets.forEach(clientSocket => {
      if (clientSocket.pseudo) { // Si le socket a un pseudo défini
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

    // Créer un tableau des parties actives
    const activeGames = [];
    
    games.forEach((game, gameId) => {
      activeGames.push({
        id: gameId,
        type: 'Multijoueur',
        players: game.players.size,
        maxPlayers: 10, // À ajuster selon votre logique
        currentRound: game.currentRound + 1,
        totalRounds: game.rounds,
        startedAt: game.startTime || new Date()
      });
    });

    socket.emit('activeGames', activeGames);
  });

  // Événements d'action admin (déconnecter joueur, arrêter partie)
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
      
      // Notifier tous les joueurs que la partie est arrêtée
      const players = Array.from(game.players.values());
      io.to(gameId).emit('gameStoppedByAdmin');
      
      // Supprimer la partie
      games.delete(gameId);
    }
  });

  // Événement pour mettre à jour les paramètres du serveur
  socket.on('updateSettings', (settings) => {
    if (!socket.rooms.has('admin-room')) return;
    
    // Appliquer les nouveaux paramètres
    console.log('Nouveaux paramètres:', settings);
    // Ici, vous pourriez mettre à jour des variables globales ou une config
  });

  socket.on('getActivityHistory', () => {
    if (!socket.rooms.has('admin-room')) return;
    
    socket.emit('activityHistory', {
        timestamps: playersHistory.timestamps,
        counts: playersHistory.counts
    });
  });

  // Dans votre fichier server.js, ajoutez ce gestionnaire d'événement
  socket.on('getDetailedStats', () => {
    if (!socket.rooms.has('admin-room')) return;
    
    // Création de données de distribution de scores basées sur les scores réels
    const scoreDistribution = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // 10 catégories
    
    leaderboard.forEach(player => {
        const score = player.score;
        const index = Math.min(9, Math.floor(score / 500)); // 0-500, 500-1000, etc.
        if (index >= 0 && index < 10) {
            scoreDistribution[index]++;
        }
    });
    
    // Activité quotidienne (à partir de StatsHistory)
    const dailyActivity = [0, 0, 0, 0, 0, 0, 0]; // Pour les 7 derniers jours
    
    // Recueillir les données des destinations difficiles
    const difficultLocations = [];
    
    // Collecting real data would require additional tracking, but here's what we've tracked:
    socket.emit('detailedStats', {
        scoreDistribution,
        dailyActivity,
        difficultLocations
    });
  });

  socket.on('getGameHistory', async () => {
    if (!socket.rooms.has('admin-room')) return;
    
    try {
      // Récupérer les 20 dernières parties
      const history = await GameHistory.find()
        .sort({ endTime: -1 })
        .limit(20);
      
      socket.emit('gameHistory', history);
    } catch (err) {
      console.error('Erreur lors de la récupération de l\'historique:', err);
      socket.emit('gameHistory', []);
    }
  });
});

// Fonction pour générer des lieux (similaire à findValidLocation du client)
async function generateLocations(count) {
  // Pour le moment, retournons des coordonnées aléatoires (à améliorer avec l'API StreetView)
  const locations = [];
  for (let i = 0; i < count; i++) {
    locations.push({
      lat: Math.random() * 160 - 80,
      lng: Math.random() * 360 - 180
    });
  }
  return locations;
}

function generateGameId() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// Fonction pour sauvegarder les statistiques
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

// Fonction pour calculer le score moyen (améliorée)
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

// Fonction pour calculer la tendance d'activité
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
  
  // Si nous avons suffisamment d'historique pour calculer une tendance (au moins 2 points)
  if (playersHistory.counts.length >= 2) {
    // Comparer avec la valeur d'il y a 1 heure (ou la plus ancienne disponible)
    const current = onlinePlayers;
    const previous = playersHistory.counts[0];
    
    return current - previous;
  }
  
  return 0; // Pas assez de données
}

// Mettre à jour l'historique des joueurs toutes les heures
setInterval(() => {
  calculateOnlineTrend(); // Cette fonction met à jour l'historique
}, 3600000); // 3600000 ms = 1 heure

// Enregistrer l'historique des statistiques toutes les heures
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
}, 3600000); // 3600000 ms = 1 heure

app.get('/admin', (req, res) => {
  const password = req.query.key;
  const adminPassword = 'QUENTIN44';
  
  // Vérifier uniquement le mot de passe sans restriction d'IP
  if (password === adminPassword) {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  } else {
    res.status(403).send('<h1>Accès refusé</h1><p>Mot de passe incorrect</p>');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Fonction pour sauvegarder une partie terminée dans l'historique
async function saveGameToHistory(gameId, game, finalResults) {
  try {
    // Créer un document d'historique de partie
    await GameHistory.create({
      gameId: gameId,
      startTime: game.startTime || new Date(Date.now() - 1000 * 60 * game.rounds), // Estimation si startTime non disponible
      endTime: new Date(),
      rounds: game.rounds,
      players: finalResults,
      locations: game.locations
    });
    
    console.log(`Partie ${gameId} sauvegardée dans l'historique`);
  } catch (err) {
    console.error('Erreur lors de l\'enregistrement de l\'historique de partie:', err);
  }
}

// Dans votre fichier JavaScript admin
function refreshGameHistory() {
  socket.emit('getGameHistory');
  document.getElementById('game-history').innerHTML = '<tr><td colspan="6">Chargement de l\'historique...</td></tr>';
}

socket.on('gameHistory', (history) => {
  const tableBody = document.getElementById('game-history');
  tableBody.innerHTML = '';
  
  if (!history || history.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="6">Aucune partie dans l\'historique</td></tr>';
    return;
  }
  
  history.forEach(game => {
    const startDate = new Date(game.startTime);
    const endDate = new Date(game.endTime);
    const duration = Math.round((endDate - startDate) / 60000); // en minutes
    
    // Trouver le meilleur score
    let bestScore = 0;
    let bestPlayer = '';
    
    if (game.players && game.players.length > 0) {
      bestScore = game.players[0].score;
      bestPlayer = game.players[0].pseudo;
    }
    
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${game.gameId}</td>
      <td>${startDate.toLocaleString()}</td>
      <td>${duration} min</td>
      <td>${game.players ? game.players.length : 0}</td>
      <td>${game.rounds}</td>
      <td>${bestPlayer}: ${bestScore} pts</td>
    `;
    tableBody.appendChild(row);
  });
});

// Appeler au chargement de la page
document.addEventListener('DOMContentLoaded', () => {
  // ... autres initialisations ...
  refreshGameHistory();
});
