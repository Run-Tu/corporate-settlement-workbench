from db import initialize_database

def main():

    db_path = initialize_database()
    print(f"Initialized SQLite database: {db_path}")

if __name__ == "__main__":
    main()
