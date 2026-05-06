export default function Home({ onPick }) {
  return (
    <div className="app">
      <div className="topbar">
        <h1>GarenMovies</h1>
      </div>
      <div className="content">
        <div className="home">
          <h2>Watch party between friends</h2>
          <div className="actions">
            <button className="primary" onClick={() => onPick('host')}>Héberger une room</button>
            <button onClick={() => onPick('client')}>Rejoindre une room</button>
          </div>
        </div>
      </div>
    </div>
  );
}
