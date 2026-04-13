import { Link } from "react-router-dom";

const BottomNavigation = () => {
  return (
    <div className="flex justify-evenly fixed bottom-0 left-0 w-full bg-gray-800 text-white">
      <Link to="/" className="px-4 py-2 rounded-md">
        Home
      </Link>
      <Link to="/library" className="px-4 py-2 rounded-md">
        Library
      </Link>
      <Link to="/import" className="px-4 py-2 rounded-md">
        Import
      </Link>
      <Link to="/search" className="px-4 py-2 rounded-md">
        Search
      </Link>
    </div>
  );
};

export default BottomNavigation;
